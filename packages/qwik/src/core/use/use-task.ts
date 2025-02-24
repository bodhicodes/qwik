import { newInvokeContext, invoke, waitAndRun, untrack } from './use-core';
import { logError, logErrorAndStop } from '../util/log';
import { delay, safeCall, then } from '../util/promises';
import { isFunction, isObject, type ValueOrPromise } from '../util/types';
import { isServerPlatform } from '../platform/platform';
import { implicit$FirstArg } from '../util/implicit_dollar';
import { assertDefined, assertEqual } from '../error/assert';
import type { QRL } from '../qrl/qrl.public';
import { assertQrl, assertSignal, createQRL, type QRLInternal } from '../qrl/qrl-class';
import { codeToText, QError_trackUseStore } from '../error/error';
import { useOn, useOnDocument } from './use-on';
import { type ContainerState, intToStr, type MustGetObjID, strToInt } from '../container/container';
import { notifyTask, _hW } from '../render/dom/notify-render';
import { useSequentialScope } from './use-sequential-scope';
import type { QwikElement } from '../render/dom/virtual-element';
import { handleError } from '../render/error-handling';
import type { RenderContext } from '../render/types';
import {
  getSubscriptionManager,
  noSerialize,
  type NoSerialize,
  unwrapProxy,
} from '../state/common';
import {
  isSignal,
  QObjectSignalFlags,
  type Signal,
  type SignalInternal,
  SIGNAL_IMMUTABLE,
  SIGNAL_UNASSIGNED,
  _createSignal,
  type ReadonlySignal,
} from '../state/signal';
import { QObjectManagerSymbol } from '../state/constants';

export const TaskFlagsIsVisibleTask = 1 << 0;
export const TaskFlagsIsTask = 1 << 1;
export const TaskFlagsIsResource = 1 << 2;
export const TaskFlagsIsComputed = 1 << 3;
export const TaskFlagsIsDirty = 1 << 4;
export const TaskFlagsIsCleanup = 1 << 5;

// <docs markdown="../readme.md#Tracker">
// !!DO NOT EDIT THIS COMMENT DIRECTLY!!!
// (edit ../readme.md#Tracker instead)
/**
 * Used to signal to Qwik which state should be watched for changes.
 *
 * The `Tracker` is passed into the `taskFn` of `useTask`. It is intended to be used to wrap
 * state objects in a read proxy which signals to Qwik which properties should be watched for
 * changes. A change to any of the properties causes the `taskFn` to rerun.
 *
 * ### Example
 *
 * The `obs` passed into the `taskFn` is used to mark `state.count` as a property of interest.
 * Any changes to the `state.count` property will cause the `taskFn` to rerun.
 *
 * ```tsx
 * const Cmp = component$(() => {
 *   const store = useStore({ count: 0, doubleCount: 0 });
 *   useTask$(({ track }) => {
 *     const count = track(() => store.count);
 *     store.doubleCount = 2 * count;
 *   });
 *   return (
 *     <div>
 *       <span>
 *         {store.count} / {store.doubleCount}
 *       </span>
 *       <button onClick$={() => store.count++}>+</button>
 *     </div>
 *   );
 * });
 * ```
 *
 * @see `useTask`
 *
 * @public
 */
// </docs>
export interface Tracker {
  /**
   * Include the expression using stores / signals to track:
   *
   * ```tsx
   * track(() => store.value)
   * ```
   *
   * The `track()` function also returns the value of the scoped expression:
   *
   * ```tsx
   * const count = track(() => store.count);
   * ```
   */
  <T>(ctx: () => T): T;

  /**
   * Used to track the whole object. If any property of the passed store changes,
   * the task will be scheduled to run.
   */
  <T extends {}>(obj: T): T;
}

/**
 * @public
 */
export interface TaskCtx {
  track: Tracker;
  cleanup(callback: () => void): void;
}

/**
 * @public
 */
export interface ResourceCtx<T> {
  readonly track: Tracker;
  cleanup(callback: () => void): void;
  cache(policyOrMilliseconds: number | 'immutable'): void;
  readonly previous: T | undefined;
}

/**
 * @public
 */
export type TaskFn = (ctx: TaskCtx) => ValueOrPromise<void | (() => void)>;

/**
 * @public
 */
export type ComputedFn<T> = () => T;

/**
 * @public
 */
export type ResourceFn<T> = (ctx: ResourceCtx<any>) => ValueOrPromise<T>;

/**
 * @public
 */
export type ResourceReturn<T> = ResourcePending<T> | ResourceResolved<T> | ResourceRejected<T>;

/**
 * @public
 */
export interface ResourcePending<T> {
  readonly value: Promise<T>;
  readonly loading: boolean;
}

/**
 * @public
 */
export interface ResourceResolved<T> {
  readonly value: Promise<T>;
  readonly loading: boolean;
}

/**
 * @public
 */
export interface ResourceRejected<T> {
  readonly value: Promise<T>;
  readonly loading: boolean;
}

export interface ResourceReturnInternal<T> {
  __brand: 'resource';
  _state: 'pending' | 'resolved' | 'rejected';
  _resolved: T | undefined;
  _error: any;
  _cache: number;
  _timeout: number;
  value: Promise<T>;
  loading: boolean;
}
/**
 * @public
 */
export interface DescriptorBase<T = any, B = undefined> {
  $qrl$: QRLInternal<T>;
  $el$: QwikElement;
  $flags$: number;
  $index$: number;
  $destroy$?: NoSerialize<() => void>;
  $state$: B;
}

/**
 * @public
 */
export type EagernessOptions = 'visible' | 'load' | 'idle';

/**
 * @public
 */
export type VisibleTaskStrategy = 'intersection-observer' | 'document-ready' | 'document-idle';

/**
 * @public
 */
export interface OnVisibleTaskOptions {
  /**
   * The strategy to use to determine when the "VisibleTask" should first execute.
   *
   * - `intersection-observer`: the task will first execute when the element is visible in the viewport, under the hood it uses the IntersectionObserver API.
   * - `document-ready`: the task will first execute when the document is ready, under the hood it uses the document `load` event.
   * - `document-idle`: the task will first execute when the document is idle, under the hood it uses the requestIdleCallback API.
   */
  strategy?: VisibleTaskStrategy;
}

/**
 * @public
 */
export interface UseTaskOptions {
  /**
   * - `visible`: run the effect when the element is visible.
   * - `load`: eagerly run the effect when the application resumes.
   */
  eagerness?: EagernessOptions;
}

// <docs markdown="../readme.md#useTask">
// !!DO NOT EDIT THIS COMMENT DIRECTLY!!!
// (edit ../readme.md#useTask instead)
/**
 * Reruns the `taskFn` when the observed inputs change.
 *
 * Use `useTask` to observe changes on a set of inputs, and then re-execute the `taskFn` when
 * those inputs change.
 *
 * The `taskFn` only executes if the observed inputs change. To observe the inputs, use the `obs`
 * function to wrap property reads. This creates subscriptions that will trigger the `taskFn` to
 * rerun.
 *
 * @see `Tracker`
 *
 * @public
 *
 * ### Example
 *
 * The `useTask` function is used to observe the `state.count` property. Any changes to the
 * `state.count` cause the `taskFn` to execute which in turn updates the `state.doubleCount` to
 * the double of `state.count`.
 *
 * ```tsx
 * const Cmp = component$(() => {
 *   const store = useStore({
 *     count: 0,
 *     doubleCount: 0,
 *     debounced: 0,
 *   });
 *
 *   // Double count task
 *   useTask$(({ track }) => {
 *     const count = track(() => store.count);
 *     store.doubleCount = 2 * count;
 *   });
 *
 *   // Debouncer task
 *   useTask$(({ track }) => {
 *     const doubleCount = track(() => store.doubleCount);
 *     const timer = setTimeout(() => {
 *       store.debounced = doubleCount;
 *     }, 2000);
 *     return () => {
 *       clearTimeout(timer);
 *     };
 *   });
 *   return (
 *     <div>
 *       <div>
 *         {store.count} / {store.doubleCount}
 *       </div>
 *       <div>{store.debounced}</div>
 *     </div>
 *   );
 * });
 * ```
 *
 * @param task - Function which should be re-executed when changes to the inputs are detected
 * @public
 */
// </docs>
export const useTaskQrl = (qrl: QRL<TaskFn>, opts?: UseTaskOptions): void => {
  const { get, set, iCtx, i, elCtx } = useSequentialScope<boolean>();
  if (get) {
    return;
  }
  assertQrl(qrl);

  const containerState = iCtx.$renderCtx$.$static$.$containerState$;
  const task = new Task(TaskFlagsIsDirty | TaskFlagsIsTask, i, elCtx.$element$, qrl, undefined);
  set(true);
  qrl.$resolveLazy$(containerState.$containerEl$);
  if (!elCtx.$tasks$) {
    elCtx.$tasks$ = [];
  }
  elCtx.$tasks$.push(task);
  waitAndRun(iCtx, () => runTask(task, containerState, iCtx.$renderCtx$));
  if (isServerPlatform()) {
    useRunTask(task, opts?.eagerness);
  }
};

interface ComputedQRL {
  <T>(qrl: QRL<ComputedFn<T>>): ReadonlySignal<Awaited<T>>;
}

interface Computed {
  <T>(qrl: ComputedFn<T>): ReadonlySignal<Awaited<T>>;
}

/**
 * @public
 */
export const useComputedQrl: ComputedQRL = <T>(qrl: QRL<ComputedFn<T>>): Signal<Awaited<T>> => {
  const { get, set, iCtx, i, elCtx } = useSequentialScope<Signal<Awaited<T>>>();
  if (get) {
    return get;
  }
  assertQrl(qrl);
  const containerState = iCtx.$renderCtx$.$static$.$containerState$;
  const signal = _createSignal(
    undefined as Awaited<T>,
    containerState,
    SIGNAL_UNASSIGNED | SIGNAL_IMMUTABLE,
    undefined
  );

  const task = new Task(
    TaskFlagsIsDirty | TaskFlagsIsTask | TaskFlagsIsComputed,
    i,
    elCtx.$element$,
    qrl,
    signal
  );
  qrl.$resolveLazy$(containerState.$containerEl$);
  if (!elCtx.$tasks$) {
    elCtx.$tasks$ = [];
  }
  elCtx.$tasks$.push(task);

  waitAndRun(iCtx, () => runComputed(task, containerState, iCtx.$renderCtx$));
  return set(signal);
};

/**
 * @public
 */
export const useComputed$: Computed = implicit$FirstArg(useComputedQrl);

// <docs markdown="../readme.md#useTask">
// !!DO NOT EDIT THIS COMMENT DIRECTLY!!!
// (edit ../readme.md#useTask instead)
/**
 * Reruns the `taskFn` when the observed inputs change.
 *
 * Use `useTask` to observe changes on a set of inputs, and then re-execute the `taskFn` when
 * those inputs change.
 *
 * The `taskFn` only executes if the observed inputs change. To observe the inputs, use the `obs`
 * function to wrap property reads. This creates subscriptions that will trigger the `taskFn` to
 * rerun.
 *
 * @see `Tracker`
 *
 * @public
 *
 * ### Example
 *
 * The `useTask` function is used to observe the `state.count` property. Any changes to the
 * `state.count` cause the `taskFn` to execute which in turn updates the `state.doubleCount` to
 * the double of `state.count`.
 *
 * ```tsx
 * const Cmp = component$(() => {
 *   const store = useStore({
 *     count: 0,
 *     doubleCount: 0,
 *     debounced: 0,
 *   });
 *
 *   // Double count task
 *   useTask$(({ track }) => {
 *     const count = track(() => store.count);
 *     store.doubleCount = 2 * count;
 *   });
 *
 *   // Debouncer task
 *   useTask$(({ track }) => {
 *     const doubleCount = track(() => store.doubleCount);
 *     const timer = setTimeout(() => {
 *       store.debounced = doubleCount;
 *     }, 2000);
 *     return () => {
 *       clearTimeout(timer);
 *     };
 *   });
 *   return (
 *     <div>
 *       <div>
 *         {store.count} / {store.doubleCount}
 *       </div>
 *       <div>{store.debounced}</div>
 *     </div>
 *   );
 * });
 * ```
 *
 * @param task - Function which should be re-executed when changes to the inputs are detected
 * @public
 */
// </docs>
export const useTask$ = /*#__PURE__*/ implicit$FirstArg(useTaskQrl);

// <docs markdown="../readme.md#useVisibleTask">
// !!DO NOT EDIT THIS COMMENT DIRECTLY!!!
// (edit ../readme.md#useVisibleTask instead)
/**
 * ```tsx
 * const Timer = component$(() => {
 *   const store = useStore({
 *     count: 0,
 *   });
 *
 *   useVisibleTask$(() => {
 *     // Only runs in the client
 *     const timer = setInterval(() => {
 *       store.count++;
 *     }, 500);
 *     return () => {
 *       clearInterval(timer);
 *     };
 *   });
 *
 *   return <div>{store.count}</div>;
 * });
 * ```
 *
 * @public
 */
// </docs>
export const useVisibleTaskQrl = (qrl: QRL<TaskFn>, opts?: OnVisibleTaskOptions): void => {
  const { get, set, i, iCtx, elCtx } = useSequentialScope<Task>();
  const eagerness = opts?.strategy ?? 'intersection-observer';
  if (get) {
    if (isServerPlatform()) {
      useRunTask(get, eagerness);
    }
    return;
  }
  assertQrl(qrl);
  const task = new Task(TaskFlagsIsVisibleTask, i, elCtx.$element$, qrl, undefined);
  const containerState = iCtx.$renderCtx$.$static$.$containerState$;
  if (!elCtx.$tasks$) {
    elCtx.$tasks$ = [];
  }
  elCtx.$tasks$.push(task);
  set(task);
  useRunTask(task, eagerness);
  if (!isServerPlatform()) {
    qrl.$resolveLazy$(containerState.$containerEl$);
    notifyTask(task, containerState);
  }
};

// <docs markdown="../readme.md#useVisibleTask">
// !!DO NOT EDIT THIS COMMENT DIRECTLY!!!
// (edit ../readme.md#useVisibleTask instead)
/**
 * ```tsx
 * const Timer = component$(() => {
 *   const store = useStore({
 *     count: 0,
 *   });
 *
 *   useVisibleTask$(() => {
 *     // Only runs in the client
 *     const timer = setInterval(() => {
 *       store.count++;
 *     }, 500);
 *     return () => {
 *       clearInterval(timer);
 *     };
 *   });
 *
 *   return <div>{store.count}</div>;
 * });
 * ```
 *
 * @public
 */
// </docs>
export const useVisibleTask$ = /*#__PURE__*/ implicit$FirstArg(useVisibleTaskQrl);

export type TaskDescriptor = DescriptorBase<TaskFn>;

export interface ResourceDescriptor<T>
  extends DescriptorBase<ResourceFn<T>, ResourceReturnInternal<T>> {}

export interface ComputedDescriptor<T> extends DescriptorBase<ComputedFn<T>, SignalInternal<T>> {}

export type SubscriberHost = QwikElement;

export type SubscriberEffect = TaskDescriptor | ResourceDescriptor<any> | ComputedDescriptor<any>;

export const isResourceTask = (task: SubscriberEffect): task is ResourceDescriptor<any> => {
  return (task.$flags$ & TaskFlagsIsResource) !== 0;
};

export const isComputedTask = (task: SubscriberEffect): task is ComputedDescriptor<any> => {
  return (task.$flags$ & TaskFlagsIsComputed) !== 0;
};
export const runSubscriber = async (
  task: SubscriberEffect,
  containerState: ContainerState,
  rCtx: RenderContext
) => {
  assertEqual(!!(task.$flags$ & TaskFlagsIsDirty), true, 'Resource is not dirty', task);
  if (isResourceTask(task)) {
    return runResource(task, containerState, rCtx);
  } else if (isComputedTask(task)) {
    return runComputed(task, containerState, rCtx);
  } else {
    return runTask(task, containerState, rCtx);
  }
};

export const runResource = <T>(
  task: ResourceDescriptor<T>,
  containerState: ContainerState,
  rCtx: RenderContext,
  waitOn?: Promise<any>
): ValueOrPromise<void> => {
  task.$flags$ &= ~TaskFlagsIsDirty;
  cleanupTask(task);

  const el = task.$el$;
  const iCtx = newInvokeContext(rCtx.$static$.$locale$, el, undefined, 'TaskEvent');
  const { $subsManager$: subsManager } = containerState;
  iCtx.$renderCtx$ = rCtx;
  const taskFn = task.$qrl$.getFn(iCtx, () => {
    subsManager.$clearSub$(task);
  });

  const cleanups: (() => void)[] = [];
  const resource = task.$state$;
  assertDefined(
    resource,
    'useResource: when running a resource, "task.r" must be a defined.',
    task
  );

  const track: Tracker = (obj: any, prop?: string) => {
    if (isFunction(obj)) {
      const ctx = newInvokeContext();
      ctx.$renderCtx$ = rCtx;
      ctx.$subscriber$ = [0, task];
      return invoke(ctx, obj);
    }
    const manager = getSubscriptionManager(obj);
    if (manager) {
      manager.$addSub$([0, task], prop);
    } else {
      logErrorAndStop(codeToText(QError_trackUseStore), obj);
    }
    if (prop) {
      return obj[prop];
    } else if (isSignal(obj)) {
      return obj.value;
    } else {
      return obj;
    }
  };
  const resourceTarget = unwrapProxy(resource);
  const opts: ResourceCtx<T> = {
    track,
    cleanup(callback) {
      cleanups.push(callback);
    },
    cache(policy) {
      let milliseconds = 0;
      if (policy === 'immutable') {
        milliseconds = Infinity;
      } else {
        milliseconds = policy;
      }
      resource._cache = milliseconds;
    },
    previous: resourceTarget._resolved,
  };

  let resolve: (v: T) => void;
  let reject: (v: any) => void;
  let done = false;

  const setState = (resolved: boolean, value: any) => {
    if (!done) {
      done = true;
      if (resolved) {
        done = true;
        resource.loading = false;
        resource._state = 'resolved';
        resource._resolved = value;
        resource._error = undefined;

        resolve(value);
      } else {
        done = true;
        resource.loading = false;
        resource._state = 'rejected';
        resource._error = value;
        reject(value);
      }
      return true;
    }
    return false;
  };

  // Execute mutation inside empty invocation
  invoke(iCtx, () => {
    resource._state = 'pending';
    resource.loading = !isServerPlatform();
    resource.value = new Promise((r, re) => {
      resolve = r;
      reject = re;
    });
  });

  task.$destroy$ = noSerialize(() => {
    done = true;
    cleanups.forEach((fn) => fn());
  });

  const promise = safeCall(
    () => then(waitOn, () => taskFn(opts)),
    (value) => {
      setState(true, value);
    },
    (reason) => {
      setState(false, reason);
    }
  );

  const timeout = resourceTarget._timeout;
  if (timeout > 0) {
    return Promise.race([
      promise,
      delay(timeout).then(() => {
        if (setState(false, new Error('timeout'))) {
          cleanupTask(task);
        }
      }),
    ]);
  }
  return promise;
};

export const runTask = (
  task: TaskDescriptor | ComputedDescriptor<any>,
  containerState: ContainerState,
  rCtx: RenderContext
): ValueOrPromise<void> => {
  task.$flags$ &= ~TaskFlagsIsDirty;

  cleanupTask(task);
  const hostElement = task.$el$;
  const iCtx = newInvokeContext(rCtx.$static$.$locale$, hostElement, undefined, 'TaskEvent');
  iCtx.$renderCtx$ = rCtx;
  const { $subsManager$: subsManager } = containerState;
  const taskFn = task.$qrl$.getFn(iCtx, () => {
    subsManager.$clearSub$(task);
  }) as TaskFn;
  const track: Tracker = (obj: any, prop?: string) => {
    if (isFunction(obj)) {
      const ctx = newInvokeContext();
      ctx.$subscriber$ = [0, task];
      return invoke(ctx, obj);
    }
    const manager = getSubscriptionManager(obj);
    if (manager) {
      manager.$addSub$([0, task], prop);
    } else {
      logErrorAndStop(codeToText(QError_trackUseStore), obj);
    }
    if (prop) {
      return obj[prop];
    } else {
      return obj;
    }
  };
  const cleanups: (() => void)[] = [];
  task.$destroy$ = noSerialize(() => {
    cleanups.forEach((fn) => fn());
  });

  const opts: TaskCtx = {
    track,
    cleanup(callback) {
      cleanups.push(callback);
    },
  };
  return safeCall(
    () => taskFn(opts),
    (returnValue) => {
      if (isFunction(returnValue)) {
        cleanups.push(returnValue);
      }
    },
    (reason) => {
      handleError(reason, hostElement, rCtx);
    }
  );
};

export const runComputed = (
  task: ComputedDescriptor<any>,
  containerState: ContainerState,
  rCtx: RenderContext
): ValueOrPromise<void> => {
  assertSignal(task.$state$);
  task.$flags$ &= ~TaskFlagsIsDirty;
  cleanupTask(task);
  const hostElement = task.$el$;
  const iCtx = newInvokeContext(rCtx.$static$.$locale$, hostElement, undefined, 'ComputedEvent');
  iCtx.$subscriber$ = [0, task];
  iCtx.$renderCtx$ = rCtx;

  const { $subsManager$: subsManager } = containerState;
  const taskFn = task.$qrl$.getFn(iCtx, () => {
    subsManager.$clearSub$(task);
  }) as ComputedFn<unknown>;

  return safeCall(
    taskFn,
    (returnValue) =>
      untrack(() => {
        const signal = task.$state$;
        signal[QObjectSignalFlags] &= ~SIGNAL_UNASSIGNED;
        signal.untrackedValue = returnValue;
        signal[QObjectManagerSymbol].$notifySubs$();
      }),
    (reason) => {
      handleError(reason, hostElement, rCtx);
    }
  );
};

export const cleanupTask = (task: SubscriberEffect) => {
  const destroy = task.$destroy$;
  if (destroy) {
    task.$destroy$ = undefined;
    try {
      destroy();
    } catch (err) {
      logError(err);
    }
  }
};

export const destroyTask = (task: SubscriberEffect) => {
  if (task.$flags$ & TaskFlagsIsCleanup) {
    task.$flags$ &= ~TaskFlagsIsCleanup;
    const cleanup = task.$qrl$;
    (cleanup as any)();
  } else {
    cleanupTask(task);
  }
};

const useRunTask = (
  task: SubscriberEffect,
  eagerness: VisibleTaskStrategy | EagernessOptions | undefined
) => {
  if (eagerness === 'visible' || eagerness === 'intersection-observer') {
    useOn('qvisible', getTaskHandlerQrl(task));
  } else if (eagerness === 'load' || eagerness === 'document-ready') {
    useOnDocument('qinit', getTaskHandlerQrl(task));
  } else if (eagerness === 'idle' || eagerness === 'document-idle') {
    useOnDocument('qidle', getTaskHandlerQrl(task));
  }
};

const getTaskHandlerQrl = (task: SubscriberEffect) => {
  const taskQrl = task.$qrl$;
  const taskHandler = createQRL(taskQrl.$chunk$, '_hW', _hW, null, null, [task], taskQrl.$symbol$);
  return taskHandler;
};

export const isTaskCleanup = (obj: any): obj is TaskDescriptor => {
  return isSubscriberDescriptor(obj) && !!(obj.$flags$ & TaskFlagsIsCleanup);
};

export const isSubscriberDescriptor = (obj: any): obj is SubscriberEffect => {
  return isObject(obj) && obj instanceof Task;
};

export const serializeTask = (task: SubscriberEffect, getObjId: MustGetObjID) => {
  let value = `${intToStr(task.$flags$)} ${intToStr(task.$index$)} ${getObjId(
    task.$qrl$
  )} ${getObjId(task.$el$)}`;
  if (task.$state$) {
    value += ` ${getObjId(task.$state$)}`;
  }
  return value;
};

export const parseTask = (data: string) => {
  const [flags, index, qrl, el, resource] = data.split(' ');
  return new Task(strToInt(flags), strToInt(index), el as any, qrl as any, resource as any);
};

export class Task<T = undefined> implements DescriptorBase<any, T> {
  constructor(
    public $flags$: number,
    public $index$: number,
    public $el$: QwikElement,
    public $qrl$: QRLInternal<any>,
    public $state$: T
  ) {}
}
