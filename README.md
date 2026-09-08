# OFD.js

纯浏览器 OFD 解析与 Canvas 2D 渲染引擎，附带 React 阅读器。TypeScript 开发，构建输出标准 JavaScript ES Modules 和类型声明；核心入口不依赖 React。

这是可运行的 **0.1 版本**，API 参考 PDF.js 的文档/页面/渲染任务分层，目前不具备 PDF.js 同等的格式覆盖率与成熟度。无需服务端转换，本地文件不上传。

## 启动与构建

需要 Node.js 20.19+。

```bash
npm install
npm run dev             # http://127.0.0.1:5173
npm run build           # dist/，用于集成的库
npm run build:demo      # demo-dist/，静态演示应用
npm pack                # 可安装的 npm 压缩包；尚未发布到 npm
```

仓库自带两页 `public/sample.ofd`，通过 `npm run sample` 重新生成。演示支持打开文件、拖放、翻页、缩放、适合宽度、旋转与兼容性提示。

## 原生 JavaScript

在其他项目安装 `npm pack` 生成的包，然后：

```js
import { getDocument } from '@ofdjs/viewer';

// 支持 File/Blob、URL/string、ArrayBuffer、Uint8Array。
const doc = await getDocument(file);
const page = await doc.getPage(1); // 页码从 1 开始
const viewport = page.getViewport({ scale: 1.25, rotation: 0 });
const task = page.render({
  canvasContext: canvas.getContext('2d'),
  viewport,
  pixelRatio: window.devicePixelRatio,
});
await task.promise;

console.log(doc.numPages, doc.metadata, doc.diagnostics);
console.log(await page.getTextContent());
// task.cancel();          // 取消渲染，promise 以 AbortError 拒绝
// doc.destroy();          // 用完后释放字体、图片、解压缓存并取消任务
```

渲染器设置 Canvas 的像素尺寸与 CSS 尺寸。`scale: 1` 使用 96 DPI，将 OFD 毫米换算为 CSS 像素；`rotation` 支持 90 的整数倍。渲染同一个 Canvas 前，应取消并等待上一个任务结束；不同 Canvas 可独立渲染。

加载与渲染均支持 `signal: AbortSignal`。URL 使用浏览器 `fetch`，跨域资源需要服务端允许 CORS。无构建工具时，直接在 `<script type="module">` 中从 `./dist/browser/ofdjs.js` 导入 `getDocument`；此文件已经打包 ZIP 依赖。通过 HTTP 服务访问即可。

## React

```tsx
import { OFDViewer } from '@ofdjs/viewer/react';
import '@ofdjs/viewer/react/style.css';

export function Preview({ file }: { file: File | null }) {
  return (
    <OFDViewer
      source={file}
      style={{ height: '80vh' }}
      initialScale={1}
      onLoad={doc => console.log(`${doc.numPages} pages`)}
      onError={error => console.error(error)}
      onDiagnostics={items => console.log(items)}
    />
  );
}
```

组件支持 React 18+。`source` 可以为 `null`；更换文件或卸载时自动取消任务并释放旧文档，支持 StrictMode。组件持有 `onLoad` 返回文档的生命周期，调用方不要提前 `destroy()`。二进制 source 应保持引用稳定，避免每次父组件渲染都新建数组触发重新加载。工具栏只渲染当前页，以限制 Canvas 内存占用。

| 属性 | 说明 |
| --- | --- |
| `source` | OFD 文件、二进制数据、URL 或 null |
| `initialScale` | 初始缩放比例，默认 1 |
| `className` / `style` | 容器样式 |
| `onLoad(document)` | 文档加载完成，页面尚未保证绘制完成 |
| `onError(error)` | 加载或渲染失败 |
| `onDiagnostics(items)` | 每次页面绘制完成后的累计兼容性提示 |

## 格式支持

| 范围 | 当前实现 |
| --- | --- |
| ZIP / XML | 命名空间无关解析、相对/根路径、资源缓存、多文档索引 |
| 页面 | 优先页面 PhysicalBox，其次文档默认尺寸；兼容缺失默认 PageArea 但页面自带尺寸的文件；模板背景/前景、图层顺序、可见性、普通批注 Appearance |
| 文字 | TextCode、X/Y、DeltaX/DeltaY、g 重复、CTM、字号、横向缩放、填充/描边 |
| 字体 | 浏览器可解码的嵌入字体通过 FontFace 加载；缺失/不支持时回退并提示 |
| 路径 | M/S/L/Q/B/A/C，直线、贝塞尔曲线、椭圆弧、填充规则、线宽、虚线、端点/连接样式 |
| 绘图参数 | DrawParam、Relative 继承、对象和图层参数 |
| 颜色 | RGB、Gray、CMYK 近似转换，BitsPerComponent、Palette、Alpha |
| 裁剪 | Boundary、路径型 Clips；同一 Clip 的路径合并后裁剪 |
| 图片 | 浏览器 createImageBitmap 可解码的 PNG/JPEG/WebP 等；单位矩形 + CTM |
| 生命周期 | 加载取消、渲染取消、文档隔离、图片与字体释放 |

已知限制：

- 数字签章/SES/ASN.1 内嵌印章、签名密码学验证尚未实现。有签名的文档会显示提示，不能据此判断文件完整性或法律有效性。
- JBIG2、部分 TIFF 等浏览器不支持的图片编码尚未接入；解码失败会提示，继续绘制其他内容。
- CGTransform 显式字形映射、复杂文字方向、文字形状裁剪、CompositeObject、渐变/图案填充、图像掩码与 ICC 色彩管理未完整支持。混合裁剪规则的复合区域可能与标准阅读器存在差异。
- 系统字体回退可能改变字形和无显式字距文字的布局；浏览器 Canvas 不提供任意 glyph ID 绘制。
- 文字提取返回对象文字及局部 Boundary，未提供页面级选择文字层、搜索高亮或无障碍文字布局。
- 暂无缩略图面板、打印接口、流式按页解压和完整解析 Worker。ZIP 异步解压后仍在主线程解析 XML，绘制每 100 个节点让出一次事件循环。
- `diagnostics` 是发现的兼容性问题清单，不是完整 OFD 合规性检查报告。

## 页面尺寸兼容处理

部分生成器省略 `Document.xml/CommonData/PageArea`，只在各页 `Content.xml/Area/PhysicalBox` 中指定尺寸。解析器允许加载此类文件，并通过 `MISSING_DEFAULT_PAGE_AREA` 提示；每页使用自身尺寸。若该页和文档默认尺寸均缺失，则 `getPage()` 返回包含页码的明确错误，不猜测 A4 或套用其他页面的尺寸。

回归测试使用自生成数据覆盖页面尺寸独立声明、默认尺寸继承、页面覆盖默认值及两处都缺失的情况。用户业务原件不放入仓库或发布包。

## 资源限制

`getDocument(source, options)` 可配置：

| 选项 | 默认值 |
| --- | --- |
| `maxFileSize` | 64 MiB 压缩大小 |
| `maxUncompressedSize` | 256 MiB ZIP 声明解压总量 |
| `maxEntries` | 10,000 ZIP 条目 |
| `documentIndex` | 0，选择 DocBody |
| `signal` | 可选加载取消信号 |

`render` 的 `maxCanvasPixels` 默认 32,000,000，超出会报错，请降低 scale 或 pixelRatio。拒绝 DTD/实体声明、向 ZIP 根之外遍历的路径及重复规范化条目。这些限制不是对所有恶意压缩包/字体/图像的隔离保证；依赖浏览器与解码库的实现。

## 验证

```bash
npm run typecheck
npm test
npx playwright install chromium
npm run test:browser
# 或使用已经安装的 Chrome
PLAYWRIGHT_CHANNEL=chrome npm run test:browser
# 添加外部真实样本（不将第三方文件再分发进仓库）
OFD_REFERENCE_FILES=/path/a.ofd,/path/b.ofd PLAYWRIGHT_CHANNEL=chrome npm run test:browser
```

核心测试覆盖路径解析、文字/模板模型、非法文件、取消与资源限制；浏览器测试检查实际像素、交互、错误恢复、取消和文档隔离。外部样本测试逐页渲染，不代表与标准阅读器逐像素一致。

## 代码结构

```text
src/core/archive.ts     获取文件、ZIP 解压、XML 缓存
src/core/xml.ts         XML / 路径 / 数值工具
src/core/document.ts    文档、页面、资源与生命周期
src/core/path.ts        OFD 路径到 Canvas 指令
src/core/render.ts      Canvas 渲染任务
src/react/             React 组件与独立样式
scripts/sample.mjs     自有演示 OFD 生成器
tests/                 单元与浏览器测试
demo/                  本地集成示例
```

## 参考与许可

参考用户指定的 [DLTech21/ofd.js](https://github.com/DLTech21/ofd.js)（Apache-2.0）与 [besthqs/bestofdview](https://github.com/besthqs/bestofdview) 的项目说明及 OFD 处理思路。实现为独立编写，未复制其源码、字体或签章算法；参考仓库的文件仅用于本地兼容性验证。`fflate` 为 MIT 许可。项目采用 MIT 许可。
