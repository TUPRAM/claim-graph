"use client";

import { toPng } from "html-to-image";

function shouldSkipNode(node: HTMLElement) {
  return node.classList.contains("react-flow__controls") ||
    node.classList.contains("react-flow__minimap") ||
    node.classList.contains("react-flow__attribution");
}

export async function exportElementToPng(input: {
  element: HTMLElement;
  filename: string;
}) {
  const dataUrl = await toPng(input.element, {
    backgroundColor: "#f8fafc",
    cacheBust: true,
    pixelRatio: 2,
    filter: (node) => !(node instanceof HTMLElement && shouldSkipNode(node))
  });

  const anchor = document.createElement("a");
  anchor.href = dataUrl;
  anchor.download = input.filename;
  anchor.click();

  return dataUrl;
}
