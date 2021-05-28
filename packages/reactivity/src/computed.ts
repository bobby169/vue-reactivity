import { effect, ReactiveEffect, trigger, track } from './effect'
import { TriggerOpTypes, TrackOpTypes } from './operations'
import { Ref } from './ref'
import { isFunction, NOOP } from '@vue/shared'
import { ReactiveFlags, toRaw } from './reactive'

export interface ComputedRef<T = any> extends WritableComputedRef<T> {
  readonly value: T
}

export interface WritableComputedRef<T> extends Ref<T> {
  readonly effect: ReactiveEffect<T>
}

export type ComputedGetter<T> = (ctx?: any) => T
export type ComputedSetter<T> = (v: T) => void

export interface WritableComputedOptions<T> {
  get: ComputedGetter<T>
  set: ComputedSetter<T>
}

// computed内部实现是用的effect()函数，返回计算结果值。相当于对effect()函数进行了重新包装，只是得到reactive返回的计算值
// computed中有effect函数，所以会有副作用存在，在组件component的setup中，会有：
// const c = _computed(getterOrOptions as any)
// recordInstanceBoundEffect(c.effect)
// 记录所有的effect，在组件unmount后，对用stop()清除副作用
class ComputedRefImpl<T> {
  private _value!: T
  private _dirty = true

  public readonly effect: ReactiveEffect<T>

  // 用isRef(computed)时，是true
  public readonly __v_isRef = true;
  // 标记readonly是否为true，如果computed只是一个函数，则为true。否则为false
  public readonly [ReactiveFlags.IS_READONLY]: boolean

  constructor(
    getter: ComputedGetter<T>,
    private readonly _setter: ComputedSetter<T>,
    isReadonly: boolean
  ) {
    // computed内部有一个effect监听函数
    // const value = reactive<{ foo?: number }>({})
    // const cValue = computed(() => value.foo)
    // stop(cValue.effect) // 可以用stop(computed.effect)来停止监听
    this.effect = effect(getter, {
      lazy: true,
      scheduler: () => {
        if (!this._dirty) {
          this._dirty = true
          // 触发TriggerOpTypes.SET类型
          trigger(toRaw(this), TriggerOpTypes.SET, 'value')
        }
      }
    })

    this[ReactiveFlags.IS_READONLY] = isReadonly
  }

  get value() {
    // the computed ref may get wrapped by other proxies e.g. readonly() #3376
    const self = toRaw(this)
    if (self._dirty) {
      // 把effect()函数返回的值保存到_value中
      self._value = this.effect() // 延迟执行effect()函数中的函数，一定会得到computed返回值
      self._dirty = false
    }
    // 继续收集target为self自身的依赖dep
    track(self, TrackOpTypes.GET, 'value')
    // 返回self._value值，对ref()后的computed要加.value获取值
    // const a = ref(1)
    // const b = computed(() => a + 1)
    // console.info(b.value)
    return self._value
  }

  // 如果computed中有set方法，则直接把newValue放到set中
  set value(newValue: T) {
    this._setter(newValue)
  }
}
// 函数重载
// 入参为getter函数
export function computed<T>(getter: ComputedGetter<T>): ComputedRef<T>
// 入参为配置项
export function computed<T>(
  options: WritableComputedOptions<T>
): WritableComputedRef<T>
// 真正的函数实现
export function computed<T>(
  getterOrOptions: ComputedGetter<T> | WritableComputedOptions<T>
) {
  let getter: ComputedGetter<T>
  let setter: ComputedSetter<T>

  if (isFunction(getterOrOptions)) {
    // 如果computed是一个函数，则只有setter
    getter = getterOrOptions
    setter = __DEV__
      ? () => {
          console.warn('Write operation failed: computed value is readonly')
        }
      : NOOP
  } else {
    // 否则即有getter，也有setter
    getter = getterOrOptions.get
    setter = getterOrOptions.set
  }

  return new ComputedRefImpl(
    getter,
    setter,
    isFunction(getterOrOptions) || !getterOrOptions.set
  ) as any
}
