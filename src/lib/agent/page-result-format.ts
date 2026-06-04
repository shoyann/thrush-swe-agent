function taskLooksChinese(text: string) {
  return /[\u4e00-\u9fff]/u.test(text);
}

function parseReadPageToolContent(content: string) {
  const lines = content.split(/\r?\n/);
  const finalUrlLine = lines.find((line) => line.startsWith("final_url: "));
  const pageTitleLine = lines.find((line) => line.startsWith("page_title: "));
  const visibleTextIndex = lines.findIndex(
    (line) => line === "visible_text_sample:",
  );

  if (!finalUrlLine || !pageTitleLine || visibleTextIndex === -1) {
    return null;
  }

  return {
    finalUrl: finalUrlLine.slice("final_url: ".length).trim(),
    pageTitle: pageTitleLine.slice("page_title: ".length).trim(),
    visibleTextSample: lines.slice(visibleTextIndex + 1).join("\n").trim(),
  };
}

function parseClickPageToolContent(content: string) {
  const lines = content.split(/\r?\n/);
  const clickedSelectorLine = lines.find((line) =>
    line.startsWith("clicked_selector: "),
  );
  const finalUrlLine = lines.find((line) => line.startsWith("final_url: "));
  const pageTitleLine = lines.find((line) => line.startsWith("page_title: "));
  const visibleTextIndex = lines.findIndex(
    (line) => line === "visible_text_sample:",
  );

  if (
    !clickedSelectorLine ||
    !finalUrlLine ||
    !pageTitleLine ||
    visibleTextIndex === -1
  ) {
    return null;
  }

  return {
    clickedSelector: clickedSelectorLine
      .slice("clicked_selector: ".length)
      .trim(),
    finalUrl: finalUrlLine.slice("final_url: ".length).trim(),
    pageTitle: pageTitleLine.slice("page_title: ".length).trim(),
    visibleTextSample: lines.slice(visibleTextIndex + 1).join("\n").trim(),
  };
}

export function formatReadPageAnswer(goal: string, content: string) {
  const parsed = parseReadPageToolContent(content);

  if (!parsed) {
    return null;
  }

  if (taskLooksChinese(goal)) {
    return [
      `最终网址：${parsed.finalUrl}`,
      `页面标题：${parsed.pageTitle}`,
      `正文摘录：${parsed.visibleTextSample}`,
    ].join("\n");
  }

  return [
    `Final URL: ${parsed.finalUrl}`,
    `Page title: ${parsed.pageTitle}`,
    `Visible text sample: ${parsed.visibleTextSample}`,
  ].join("\n");
}

export function formatClickPageAnswer(goal: string, content: string) {
  const parsed = parseClickPageToolContent(content);

  if (!parsed) {
    return null;
  }

  if (taskLooksChinese(goal)) {
    return [
      `点击目标：${parsed.clickedSelector}`,
      `最终网址：${parsed.finalUrl}`,
      `页面标题：${parsed.pageTitle}`,
      `正文摘录：${parsed.visibleTextSample}`,
    ].join("\n");
  }

  return [
    `Clicked selector: ${parsed.clickedSelector}`,
    `Final URL: ${parsed.finalUrl}`,
    `Page title: ${parsed.pageTitle}`,
    `Visible text sample: ${parsed.visibleTextSample}`,
  ].join("\n");
}
