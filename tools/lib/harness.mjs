/**
 * 离线渲染 harness：给客户端插件一个假的 React / ReactDOM / window / document，
 * 让 `client.js` 能在没有浏览器的情况下真正跑起来。
 *
 * 两处消费方：
 *   · `tools/client-panel-test.mjs` —— 断言渲染结果与交互请求体；
 *   · `tools/render-panel.mjs`      —— 把渲染树序列化成 HTML 再出截图。
 *
 * 实现刻意保持极简：hook 按调用顺序复用槽位（和 React 的规则一致），
 * `useSyncExternalStore` 直接读快照，`useEffect` 不执行——足够覆盖本插件的用法。
 */

import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** 极简 hook 运行时；每次渲染前调用 `reset()`。 */
export function createReact() {
  const states = []
  let cursor = 0
  const same = (a, b) =>
    Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))

  const React = {
    createElement(type, props, ...children) {
      return {
        type,
        props: props ?? {},
        children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
      }
    },
    useRef(value) {
      const index = cursor++
      if (!(index in states)) states[index] = { current: value }
      return states[index]
    },
    useState(initial) {
      const index = cursor++
      if (!(index in states)) states[index] = { value: typeof initial === 'function' ? initial() : initial }
      const slot = states[index]
      return [
        slot.value,
        (next) => {
          slot.value = typeof next === 'function' ? next(slot.value) : next
        },
      ]
    },
    useCallback(fn, deps) {
      const index = cursor++
      const previous = states[index]
      if (!previous || !same(previous.deps, deps)) states[index] = { fn, deps }
      return states[index].fn
    },
    useMemo(fn, deps) {
      const index = cursor++
      const previous = states[index]
      if (!previous || !same(previous.deps, deps)) states[index] = { value: fn(), deps }
      return states[index].value
    },
    useEffect() {
      cursor++
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      cursor++
      return getSnapshot()
    },
  }
  return { React, reset: () => { cursor = 0 } }
}

/** 遍历渲染树。 */
export function* walk(node) {
  if (node === null || node === undefined || typeof node !== 'object') return
  yield node
  for (const child of node.children ?? []) yield* walk(child)
}

/** 收集所有满足条件的节点。 */
export const findAll = (tree, predicate) => [...walk(tree)].filter(predicate)

/** 找第一个满足条件的节点。 */
export const find = (tree, predicate) => findAll(tree, predicate)[0]

/**
 * 安装 `window` / `document` 桩，然后加载 `client.js`，返回模块定义。
 * @param {string} clientPath `client.js` 的绝对路径。
 * @returns {Promise<{id: string, factory: Function}>}
 */
export async function loadClientDefinition(clientPath) {
  let definition
  globalThis.document = { body: { nodeName: '#portal-host' } }
  globalThis.window = {
    __ModuleLoader__: {
      load(value) {
        definition = value
      },
    },
    addEventListener() {},
    removeEventListener() {},
  }
  await import(pathToFileURL(clientPath).href)
  if (definition === undefined) throw new Error('client.js 没有调用 __ModuleLoader__.load')
  return definition
}

/**
 * 用假 React 造出插件实例（`{ name, inject, apply }`）。
 * @param {{factory: Function}} definition 模块定义。
 * @param {{React: object}} react 由 {@link createReact} 造出的 React。
 * @returns 插件实例。
 */
export function createPlugin(definition, react) {
  const ReactDOM = { createPortal: (node) => node }
  const fakeRequire = (name) => {
    if (name === 'react') return react.React
    if (name === 'react-dom') return ReactDOM
    throw new Error('unexpected require: ' + name)
  }
  return definition.factory(fakeRequire)
}

/** 本文件同级目录之上的插件根目录。 */
export function pluginRoot(fromHere) {
  return path.resolve(path.dirname(fromHere), '..')
}
