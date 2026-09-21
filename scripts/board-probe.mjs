import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { writeFileSync } from "node:fs";
import App from "../src/App.tsx";

const html = renderToString(createElement(App));
const squares = (html.match(/data-square=/g) || []).length;
const occupied = (html.match(/data-occupied="1"/g) || []).length;
const hasBoard = html.includes('id="chess-board"');
const report = [
  `squares=${squares}`,
  `occupied=${occupied}`,
  `hasBoard=${hasBoard}`,
  "",
  html,
].join("\n");
const out = process.argv[2];
if (out) writeFileSync(out, report);
console.log(`squares=${squares} occupied=${occupied} hasBoard=${hasBoard}`);
if (squares !== 64 || occupied < 32 || !hasBoard) {
  process.exit(1);
}
