/**
 * 诊断脚本：把渲染页里插件自己那段样式表抽掉，模拟"样式表尚未生效的首帧"，
 * 用来验证「只有 viewBox 的 SVG 图标会按替换元素默认尺寸撑开按钮」这个结论。
 *
 * 用法：node tools/unstyled-check.mjs <有样式的 html> <去掉样式的 html 输出>
 */
import fs from 'node:fs'

const [, , input, output] = process.argv
if (input === undefined || output === undefined) {
  console.error('用法：node tools/unstyled-check.mjs <in.html> <out.html>')
  process.exit(1)
}

const source = fs.readFileSync(input, 'utf8')
// 只摘掉插件自己那段 <style>…</style>：按 `<style>` 切块会把 </head><body> 一起切掉，
// 结果是整页空白（前车之鉴）。
let stripped = source.replace(/<style>[\s\S]*?<\/style>/g, (block) => (block.includes('.sop-btn') ? '' : block))
// --strip-intrinsic：连 SVG 的内在尺寸也去掉，还原成「旧代码 + 样式未生效」的现场。
if (process.argv.includes('--strip-intrinsic')) {
  const hits = (stripped.match(/width="14" height="14"/g) ?? []).length
  stripped = stripped.replace(/width="14" height="14"/g, '')
  console.log('去掉内在尺寸的 svg 个数:', hits)
}
// 去掉插件 CSS 后，颜色也一并没了（图标是 currentColor），白底上会全白看不到尺寸。
// 补一个调试色，只为看清"没有样式时按钮到底多大"。
const withDebug = stripped.replace('</head>', '<style>body{color:#111;background:#fff}</style></head>')
fs.writeFileSync(output, withDebug)
console.log('去掉样式表字符数:', source.length - withDebug.length)
