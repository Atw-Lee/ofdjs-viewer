import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { OFDViewer } from '../src/react/index';
import type { OFDSource } from '../src';
import '../src/react/style.css';
import './style.css';
const baseUrl = import.meta.env.BASE_URL;
const sampleUrl = `${baseUrl}sample.ofd`;
function App() {
  const [source, setSource] = useState<OFDSource>(sampleUrl), [name, setName] = useState('sample.ofd'), [drag, setDrag] = useState(false);
  const open = (file?: File) => { if (file) { setSource(file); setName(file.name); } };
  return <main onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={e => { e.preventDefault(); setDrag(false); open(e.dataTransfer.files[0]); }}>
    <header><a href={baseUrl} className="logo">▤ <strong>ofd<span>js</span></strong><small>DOCUMENT TOOLKIT</small></a><span className="version">v0.1 · Canvas engine</span></header>
    <div className="intro"><div><span className="eyebrow">OPEN FIXED-LAYOUT DOCUMENT</span><h1>让 OFD，在 Web 中清晰呈现。</h1><p>纯前端解析 · Canvas 渲染 · React 组件</p></div><label className="open">＋ 打开 OFD 文件<input type="file" accept=".ofd" onChange={e => { open(e.target.files?.[0]); e.target.value = ''; }}/></label></div>
    <div className="filebar"><span>▤ <b>{name}</b></span><span>文件在当前浏览器内处理</span></div>
    <div className={`viewer-wrap ${drag ? 'dragging' : ''}`}><OFDViewer source={source}/></div>
    <footer><span>OFD.js — JavaScript 文档引擎与 React 阅读器</span><button onClick={() => { setSource(sampleUrl); setName('sample.ofd'); }}>打开示例文档 ↗</button></footer>
  </main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
