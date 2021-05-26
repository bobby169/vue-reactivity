import { TrackOpTypes, TriggerOpTypes } from './operations'
import { EMPTY_OBJ, isArray, isIntegerKey, isMap } from '@vue/shared'

// The main WeakMap that stores {target -> key -> dep} connections.
// Conceptually, it's easier to think of a dependency as a Dep class
// which maintains a Set of subscribers, but we simply store them as
// raw Sets to reduce memory overhead.
// Dep存放着监听函数effect的集合
type Dep = Set<ReactiveEffect>
// 这是一个二维的数据结构
type KeyToDepMap = Map<any, Dep>
// 这是一个三维的数据结构
const targetMap = new WeakMap<any, KeyToDepMap>()

export interface ReactiveEffect<T = any> {
  // 代表这是一个函数类型，不接受入参，返回结果类型为泛型T
  // T也即是原始函数的返回结果类型
  (): T
  // 可以通过isEffect()函数判断是否是监听函数
  _isEffect: true
  id: number
  // 当前的effect函数是否可继续监听？可调用stop(effect)把 active = false
  active: boolean
  // 监听函数的原始函数
  raw: () => T
  deps: Array<Dep>
  options: ReactiveEffectOptions
  // 是否允许递归
  allowRecurse: boolean
}

export interface ReactiveEffectOptions {
  // 延迟计算，为true时候，传入的effect不会立即执行。
  lazy?: boolean
  // 调度器函数，接受的入参run即是传给effect的函数，如果传了scheduler，则可通过其调用监听函数。
  scheduler?: (job: ReactiveEffect) => void
  // **仅供调试使用**。在收集依赖(get阶段)的过程中触发
  onTrack?: (event: DebuggerEvent) => void
  // **仅供调试使用**。在触发更新后执行监听函数之前触发
  onTrigger?: (event: DebuggerEvent) => void
  //通过 `stop` 终止监听函数时触发的事件
  onStop?: () => void
  // 是否允许递归
  allowRecurse?: boolean
}

export type DebuggerEvent = {
  effect: ReactiveEffect
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
} & DebuggerEventExtraInfo

export interface DebuggerEventExtraInfo {
  newValue?: any
  oldValue?: any
  oldTarget?: Map<any, any> | Set<any>
}

// 存放监听函数的数组
const effectStack: ReactiveEffect[] = []
// 用来记录当前活动的effect监听函数
let activeEffect: ReactiveEffect | undefined

export const ITERATE_KEY = Symbol(__DEV__ ? 'iterate' : '')
export const MAP_KEY_ITERATE_KEY = Symbol(__DEV__ ? 'Map key iterate' : '')

export function isEffect(fn: any): fn is ReactiveEffect {
  return fn && fn._isEffect === true
}

export function effect<T = any>(
  fn: () => T,
  options: ReactiveEffectOptions = EMPTY_OBJ
): ReactiveEffect<T> {
  // 如果该函数已经是监听函数了，那赋值fn为该函数的原始函数
  if (isEffect(fn)) {
    fn = fn.raw
  }
  // 创建一个监听函数
  const effect = createReactiveEffect(fn, options)
  // 如果不是延迟执行的话，立即执行一次
  if (!options.lazy) {
    effect()
  }
  // 返回该监听函数
  return effect
}

// stop传参effect监听函数，可以使得这个监听函数失去响应式，并把active置为false
export function stop(effect: ReactiveEffect) {
  // 如果active为true，则触发effect.onStop，并且把active置为false。
  if (effect.active) {
    cleanup(effect)
    if (effect.options.onStop) {
      effect.options.onStop()
    }
    effect.active = false
  }
}

let uid = 0

function createReactiveEffect<T = any>(
  fn: () => T,
  options: ReactiveEffectOptions
): ReactiveEffect<T> {
  // 创建监听函数，通过fn()来包裹原始函数，做额外操作
  const effect = function reactiveEffect(): unknown {
    // 如果这个active开关是关上的，那就执行原始方法，并返回
    if (!effect.active) {
      return options.scheduler ? undefined : fn()
    }
    // 如果监听函数栈中并没有此监听函数，则：
    // includes避免了递归循环看单无测代码： should avoid implicit infinite recursive loops with itself
    if (!effectStack.includes(effect)) {
      cleanup(effect)
      try {
        // 开启tracking shouldTrack = true
        enableTracking()
        // 将本effect推到effect栈中
        effectStack.push(effect)
        // 当前活动的effect为此创建的effect
        activeEffect = effect
        // 执行原始函数并返回
        return fn()
      } finally {
        // 执行完以后将effect从栈中推出
        effectStack.pop()
        resetTracking()
        // 执行完后把当前活动有effect设为effectStack栈中最后一个
        activeEffect = effectStack[effectStack.length - 1]
      }
    }
  } as ReactiveEffect
  // 自增id
  effect.id = uid++
  effect.allowRecurse = !!options.allowRecurse
  effect._isEffect = true
  effect.active = true
  effect.raw = fn
  effect.deps = []
  effect.options = options
  return effect
}

function cleanup(effect: ReactiveEffect) {
  // 获取本effect的deps，然后循环清除存储了自身effect的引用
  // 最后将deps置为空
  const { deps } = effect
  if (deps.length) {
    for (let i = 0; i < deps.length; i++) {
      deps[i].delete(effect)
    }
    deps.length = 0
  }
}

let shouldTrack = true
const trackStack: boolean[] = []

export function pauseTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = false
}

export function enableTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = true
}

export function resetTracking() {
  const last = trackStack.pop()
  shouldTrack = last === undefined ? true : last
}
/**
 * 收集依赖的函数，对target值的变化进行追踪，此函数放到handler的get中
 * fn内引用了依赖数据，执行fn触发这些数据的get，进而走到了track，而此时effectStack堆栈尾部正好是该effect
 *
 * targetMap跟effect的依赖映射到底是怎么样的?
 * targetMap的depsMap中存了effect的集合dep，而effect中又存了这个dep...乍看有点儿懵，而且为什么要双向存？
 * 就是在run方法中执行的cleanup。每次 run 之前，会执cleanup()
 *
 * 1. 对于一个响应式数据，它在targetMap中存着一个Map数据（我们称之为「响应依赖映射」）。
 *    这个响应依赖映射的key是该响应式数据的某个属性值，value是所有用到这个响应数据属性值的所有监听函数effect()，也即是Set集合dep。
 * 2. 而对于一个监听函数，它会存放着 所有存着它自身的dep。
 *
 * effect为什么要存着这么个递归数据呢？这是因为要通过cleanup方法，在自己被执行前，把自己从响应依赖映射中删除了。
 * 然后执行自身原始函数fn，然后触发数据的get，然后触发track，然后又会把本effect添加到相应的Set<ReactiveEffect>中。
 * 有点儿神奇啊，每次执行前，把自己从依赖映射中删除，执行过程中，又把自己加回去。
 * 去掉cleanup()函数，单测报错：should not be triggered by mutating a property, which is used in an inactive branch
 * 因为监听函数中，可能会由于 if 等条件判断语句导致的依赖数据不同。所以每次执行函数时，都要重新更新一次依赖。所以才有了cleanup这个逻辑
 * @param target
 * @param type
 * @param key
 * @returns
 */
export function track(target: object, type: TrackOpTypes, key: unknown) {
  // console.log(shouldTrack, activeEffect, 'shouldTrack')
  // 如果shouldTrack开关关闭，或当前活动的activeEffect为空，则无需要收集
  if (!shouldTrack || activeEffect === undefined) {
    return
  }
  console.log('proxy后有effect函数，且函数中有proxy时才会tracking')
  // 获取二维map，不存在的话，则初始化
  let depsMap = targetMap.get(target)
  if (!depsMap) {
    targetMap.set(target, (depsMap = new Map()))
  }
  // 获取effect集合，无则初始化
  let dep = depsMap.get(key)
  if (!dep) {
    depsMap.set(key, (dep = new Set()))
  }
  // 如果dep中无当前活动的effect，则把activeEffect添加到dep中
  if (!dep.has(activeEffect)) {
    dep.add(activeEffect)
    // 把dep map放入到effect.deps数组中
    activeEffect.deps.push(dep)
    // 开发环境下时，触发onTrack钩子函数
    if (__DEV__ && activeEffect.options.onTrack) {
      activeEffect.options.onTrack({
        effect: activeEffect,
        target,
        type,
        key
      })
    }
  }
}

/**
 * 触发监听函数的方法，放到handler的set中，有数据更新时触发
 * @param target // 原始数据
 * @param type // 操作类型
 * @param key // 属性key
 * @param newValue
 * @param oldValue
 * @param oldTarget
 * @returns
 */
export function trigger(
  target: object,
  type: TriggerOpTypes,
  key?: unknown,
  newValue?: unknown,
  oldValue?: unknown,
  oldTarget?: Map<unknown, unknown> | Set<unknown>
) {
  // 获取原始数据的响应依赖映射，没有的话，说明没被监听，直接返回
  const depsMap = targetMap.get(target)
  if (!depsMap) {
    // never been tracked
    return
  }

  // 用来保存所有定义的effect方法
  const effects = new Set<ReactiveEffect>()
  const add = (effectsToAdd: Set<ReactiveEffect> | undefined) => {
    if (effectsToAdd) {
      effectsToAdd.forEach(effect => {
        if (effect !== activeEffect || effect.allowRecurse) {
          effects.add(effect)
        }
      })
    }
  }

  // TriggerOpTypes.CLEAR 代表是集合数据的清除方法，会清除集合数据的所有项
  // 如果是清除操作，那就要执行依赖原始数据的所有监听方法。因为所有项都被清除了
  if (type === TriggerOpTypes.CLEAR) {
    // collection being cleared
    // trigger all effects for target
    depsMap.forEach(add)
  } else if (key === 'length' && isArray(target)) {
    depsMap.forEach((dep, key) => {
      if (key === 'length' || key >= (newValue as number)) {
        add(dep)
      }
    })
  } else {
    // schedule runs for SET | ADD | DELETE
    // key不为void 0，则说明肯定是SET | ADD | DELETE这三种操作
    // 然后将依赖这个key的所有监听函数推到相应队列中
    if (key !== void 0) {
      add(depsMap.get(key))
    }

    // also run for iteration key on ADD | DELETE | Map.SET
    switch (type) {
      case TriggerOpTypes.ADD:
        if (!isArray(target)) {
          add(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            add(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        } else if (isIntegerKey(key)) {
          // new index added to array -> length changes
          add(depsMap.get('length'))
        }
        break
      case TriggerOpTypes.DELETE:
        if (!isArray(target)) {
          add(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            add(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        }
        break
      case TriggerOpTypes.SET:
        if (isMap(target)) {
          add(depsMap.get(ITERATE_KEY))
        }
        break
    }
  }

  const run = (effect: ReactiveEffect) => {
    if (__DEV__ && effect.options.onTrigger) {
      effect.options.onTrigger({
        effect,
        target,
        key,
        type,
        newValue,
        oldValue,
        oldTarget
      })
    }
    if (effect.options.scheduler) {
      effect.options.scheduler(effect)
    } else {
      effect()
    }
  }

  // 只要在handler中的set中值有变化，或数组值有增添，会遍历执行effets中的effect()方法
  effects.forEach(run)
}
