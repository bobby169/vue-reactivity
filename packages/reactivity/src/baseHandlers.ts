import {
  reactive,
  readonly,
  toRaw,
  ReactiveFlags,
  Target,
  readonlyMap,
  reactiveMap,
  shallowReactiveMap,
  shallowReadonlyMap
} from './reactive'
import { TrackOpTypes, TriggerOpTypes } from './operations'
import {
  track,
  trigger,
  ITERATE_KEY,
  pauseTracking,
  resetTracking
} from './effect'
import {
  isObject,
  hasOwn,
  isSymbol,
  hasChanged,
  isArray,
  isIntegerKey,
  extend,
  makeMap
} from '@vue/shared'
import { isRef } from './ref'

const isNonTrackableKeys = /*#__PURE__*/ makeMap(`__proto__,__v_isRef,__isVue`)

// 把Symbol内置属性放到一个Set中，用于判断如果是Symbol，则不做依赖收集
const builtInSymbols = new Set(
  Object.getOwnPropertyNames(Symbol)
    .map(key => (Symbol as any)[key])
    .filter(isSymbol)
)

const get = /*#__PURE__*/ createGetter()
const shallowGet = /*#__PURE__*/ createGetter(false, true)
const readonlyGet = /*#__PURE__*/ createGetter(true)
const shallowReadonlyGet = /*#__PURE__*/ createGetter(true, true)

const arrayInstrumentations: Record<string, Function> = {}
// instrument identity-sensitive Array methods to account for possible reactive
// values
;(['includes', 'indexOf', 'lastIndexOf'] as const).forEach(key => {
  const method = Array.prototype[key] as any
  arrayInstrumentations[key] = function(this: unknown[], ...args: unknown[]) {
    const arr = toRaw(this)
    for (let i = 0, l = this.length; i < l; i++) {
      track(arr, TrackOpTypes.GET, i + '')
    }
    // we run the method using the original args first (which may be reactive)
    const res = method.apply(arr, args)
    if (res === -1 || res === false) {
      // if that didn't work, run it again using raw values.
      return method.apply(arr, args.map(toRaw))
    } else {
      return res
    }
  }
})
// instrument length-altering mutation methods to avoid length being tracked
// which leads to infinite loops in some cases (#2137)
;(['push', 'pop', 'shift', 'unshift', 'splice'] as const).forEach(key => {
  const method = Array.prototype[key] as any
  arrayInstrumentations[key] = function(this: unknown[], ...args: unknown[]) {
    pauseTracking()
    const res = method.apply(this, args)
    resetTracking()
    return res
  }
})

// 1. 对于原始对象数据，会通过 Proxy 劫持，返回新的响应式数据(代理数据)。
// 2. 对于代理数据的任何读写操作，都会通过Refelct反射到原始对象上。
// 3. 在这个过程中，对于读操作，会执行收集依赖的逻辑。对于写操作，会触发监听函数的逻辑。
// const original = { foo: 1 }
// const observed = reactive(original)
// observed.foo = 2
// console.log(observed.foo,original.foo) // 通过Refelct.set也改变了原始target的值

function createGetter(isReadonly = false, shallow = false) {
  return function get(target: Target, key: string | symbol, receiver: object) {
    // 这里能传入我写的__v_isReactive2
    // 这里比较巧妙，动态判断
    // proxy后的对象相当于添加了ReactiveFlags属性，用于判断对象是否是reactive或是readonly供isReactive()和isReadonly()使用
    console.log(key, 'GetKey')
    // console.log(receiver, 'receiver')
    if (key === ReactiveFlags.IS_REACTIVE) {
      console.log('判断当前target是否是proxy')
      return !isReadonly // 返回proxy[ReactiveFlags.IS_REACTIVE] = true
    } else if (key === ReactiveFlags.IS_READONLY) {
      return isReadonly // 返回proxy[ReactiveFlags.IS_READONLY] = false
    } else if (
      // 如果key是ReactiveFlags.RAW，并且receiver 与 proxyMap.get(target)相等，则返回target。供toRaw()方法调用
      // 在proxyMap中我们可以通过key为target找到proxy，也能通过toRaw()方法找到target原始对象。双向互找
      key === ReactiveFlags.RAW &&
      receiver ===
        (isReadonly
          ? shallow
            ? shallowReadonlyMap
            : readonlyMap
          : shallow
            ? shallowReactiveMap
            : reactiveMap
        ).get(target)
    ) {
      return target
    }

    const targetIsArray = isArray(target)

    if (!isReadonly && targetIsArray && hasOwn(arrayInstrumentations, key)) {
      return Reflect.get(arrayInstrumentations, key, receiver)
    }

    // 获取原始数据对象身上某个属性的值，类似于 target[name]。
    // 为什么要通过Reflect, 而不是直接target[key]?
    // 确实，target[key]好像就能实现效果了，为什么要用Reflect，还要传个receiver呢？原因在于原始数据的get并没有大家想的这么简单
    // 利用Reflect，可方便的把现有操作行为原模原样地反射到目标对象上，又保证真实的作用域（通过第三个参数receiver）。这个receiver即是生成的代理对象
    const res = Reflect.get(target, key, receiver) //receiver传给Reflect.get，保留了对正确引用this
    // console.log(res, receiver, key, 'res')
    console.log(target === receiver, 'target === receiver') // false
    console.log(target === toRaw(receiver), 'target === toRaw(receiver)') // 一般是true

    // 如果是js的内置属性，不做依赖收集
    if (isSymbol(key) ? builtInSymbols.has(key) : isNonTrackableKeys(key)) {
      return res
    }

    // 收集依赖
    if (!isReadonly) {
      track(target, TrackOpTypes.GET, key)
    }

    // 如果是shallow浅的，直接返回proxy
    if (shallow) {
      return res
    }

    // 如果是Ref类型数据，说明已经被收集过依赖，不做依赖收集，直接返回其value值
    if (isRef(res)) {
      // ref unwrapping - does not apply for Array + integer key.
      const shouldUnwrap = !targetIsArray || !isIntegerKey(key)
      return shouldUnwrap ? res.value : res
    }

    // 如果返回的proxy还是object对象，则递归执行reactive
    if (isObject(res)) {
      // Convert returned value into a proxy as well. we do the isObject check
      // here to avoid invalid value warning. Also need to lazy access readonly
      // and reactive here to avoid circular dependency.
      // 需要在此处设置readonly和reactive延迟访问，以避免循环依赖
      return isReadonly ? readonly(res) : reactive(res)
    }

    return res
  }
}

const set = /*#__PURE__*/ createSetter()
const shallowSet = /*#__PURE__*/ createSetter(true)

function createSetter(shallow = false) {
  return function set(
    target: object,
    key: string | symbol,
    value: unknown,
    receiver: object
  ): boolean {
    let oldValue = (target as any)[key]
    if (!shallow) {
      // 如果value是响应式数据，则返回其映射的源数据
      value = toRaw(value)
      oldValue = toRaw(oldValue)

      // 如果旧值是Ref数据，但新值不是，那更新旧的值的value属性值，返回更新成功
      // reactive有解套嵌套 ref 数据的能力，如：
      // const a = {
      //   b: ref(1)
      // }
      // const observed = reactive(a) // { b: 1 }
      // 此时，observed.b输出的是 1，当做赋值操作 observed.b = 2时。
      // oldValue由于是a.b，是一个Ref类型数据，而新的值并不是，进而直接修改a.b的 value 即可。
      // 那为什么直接返回，不需要往下触发 trigger 了呢？是因为在ref函数中，已经有劫持 set 的逻辑了

      if (!isArray(target) && isRef(oldValue) && !isRef(value)) {
        oldValue.value = value
        return true
      }
    } else {
      // in shallow mode, objects are set as-is regardless of reactive or not
    }

    // 代理对象中，是不是真的有这个key，没有说明操作是新增ADD
    const hadKey =
      isArray(target) && isIntegerKey(key)
        ? Number(key) < target.length
        : hasOwn(target, key)
    console.log(key, 'SetKey')

    // 将值分配给属性的函数。返回一个Boolean，如果更新成功，则返回true。将本次设置行为，反射到原始对象上
    // Receiver：最初被调用的对象。通常是 proxy 本身，但 handler 的 set 方法也有可能在原型链上或以其他方式被间接地调用（因此不一定是 proxy 本身）
    const result = Reflect.set(target, key, value, receiver)
    // don't trigger if target is something up in the prototype chain of original
    // 如果是原始数据原型链上的数据操作，不做任何触发监听函数的行为。
    if (target === toRaw(receiver)) {
      // 当数据变更时触发trigger监听函数
      if (!hadKey) {
        // 不存在key，则说明为添加操作
        trigger(target, TriggerOpTypes.ADD, key, value)
      } else if (hasChanged(value, oldValue)) {
        // 存在key，则说明是更新操作
        trigger(target, TriggerOpTypes.SET, key, value, oldValue)
      }
    }
    return result
  }
}

// 劫持属性删除
function deleteProperty(target: object, key: string | symbol): boolean {
  const hadKey = hasOwn(target, key)
  const oldValue = (target as any)[key]
  const result = Reflect.deleteProperty(target, key)
  if (result && hadKey) {
    trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
  }
  return result
}

// 劫持 in 操作符
function has(target: object, key: string | symbol): boolean {
  const result = Reflect.has(target, key)
  if (!isSymbol(key) || !builtInSymbols.has(key)) {
    track(target, TrackOpTypes.HAS, key)
  }
  return result
}

// 劫持 Object.keys
function ownKeys(target: object): (string | symbol)[] {
  track(target, TrackOpTypes.ITERATE, isArray(target) ? 'length' : ITERATE_KEY)
  return Reflect.ownKeys(target)
}

export const mutableHandlers: ProxyHandler<object> = {
  get,
  set,
  deleteProperty,
  has,
  ownKeys
}

// readonly后，set和delete会报错误提示
export const readonlyHandlers: ProxyHandler<object> = {
  get: readonlyGet,
  set(target, key) {
    if (__DEV__) {
      console.warn(
        `Set operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  },
  deleteProperty(target, key) {
    if (__DEV__) {
      console.warn(
        `Delete operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  }
}

export const shallowReactiveHandlers: ProxyHandler<object> = extend(
  {},
  mutableHandlers,
  {
    get: shallowGet,
    set: shallowSet
  }
)

// Props handlers are special in the sense that it should not unwrap top-level
// refs (in order to allow refs to be explicitly passed down), but should
// retain the reactivity of the normal readonly object.
export const shallowReadonlyHandlers: ProxyHandler<object> = extend(
  {},
  readonlyHandlers,
  {
    get: shallowReadonlyGet
  }
)
