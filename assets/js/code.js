// Code walkthrough and recipes of a feature page, from site/assets/code/<feature>.json (tools/extract_code.py).
// Source lines are inserted as text only; the notes, results and titles come from the page's own spec
// (demos/<feature>/code.json) and may contain a few inline tags (<code>, <i>, <b>).

const KEYWORDS = /^(var|let|const|function|return|if|else|for|while|true|false|null|new|exports|require|this)$/;
const TOKEN = /(\/\/.*$|\/\*.*?\*\/|\/\*.*$|^\s*\*.*$)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function trustedHtml(e, html) {
  e.innerHTML = html;
  return e;
}

/** One source line with simple JavaScript highlighting. */
function highlight(text) {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    if (m[1]) frag.append(el("span", "tok-c", m[0]));
    else if (m[2]) frag.append(el("span", "tok-s", m[0]));
    else if (m[3]) frag.append(el("span", "tok-n", m[0]));
    else if (KEYWORDS.test(m[0])) frag.append(el("span", "tok-k", m[0]));
    else frag.append(m[0]);
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

function sourceLink(repoUrl, file, start, end) {
  const a = el(repoUrl ? "a" : "span", "file", file);
  if (repoUrl) {
    a.href = `${repoUrl}${file}#L${start}` + (end && end !== start ? `-L${end}` : "");
    a.target = "_blank";
    a.rel = "noopener";
  }
  return a;
}

function copyButton(text) {
  const b = el("button", "copy", "Copy");
  b.type = "button";
  b.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      b.textContent = "Copied";
    } catch {
      b.textContent = "Select and copy";
    }
    setTimeout(() => { b.textContent = "Copy"; }, 1600);
  });
  return b;
}

export function codeBlock(range, repoUrl) {
  const fig = el("figure", "code");
  const cap = el("figcaption");
  cap.append(sourceLink(repoUrl, range.file, range.start, range.end),
    el("span", "lines", range.start === range.end ? `line ${range.start}` : `lines ${range.start}\u2013${range.end}`));
  const pre = el("pre");
  range.lines.forEach((text, i) => {
    const row = el("span", "ln" + (range.marks.includes(i) ? " hl" : ""));
    row.dataset.n = String(range.start + i);
    row.append(highlight(text), "\n");
    pre.append(row);
  });
  fig.append(cap, pre);
  return fig;
}

/** Steps into listEl; onActivate(index, step) when a step reaches the middle of the window. */
export function renderWalkthrough(listEl, code, onActivate) {
  const items = code.steps.map((step, i) => {
    const li = el("li", "walk-step");
    const h = el("h3");
    h.append(el("span", "num", String(i + 1)), step.title);
    li.append(h);
    for (const note of step.notes) li.append(trustedHtml(el("p"), note));
    for (const r of step.ranges) li.append(codeBlock(r, code.repo_url));
    listEl.append(li);
    return li;
  });
  let active = -1;
  const activate = (i) => {
    if (i === active || i < 0) return;
    active = i;
    items.forEach((li, k) => li.classList.toggle("active", k === i));
    onActivate(i, code.steps[i]);
  };
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) activate(items.indexOf(e.target));
  }, { rootMargin: "-40% 0px -55% 0px" });
  items.forEach((li) => io.observe(li));
  activate(0);
}

function changedSpan(text, other) {
  let p = 0;
  while (p < text.length && p < other.length && text[p] === other[p]) p++;
  let s = 0;
  while (s < text.length - p && s < other.length - p && text[text.length - 1 - s] === other[other.length - 1 - s]) s++;
  return [p, s];
}

const WORD = /[\w.]/;

/** Like changedSpan, but widened to whole words (OPT_OFF, not FF). */
function changedWords(text, other) {
  let [p, s] = changedSpan(text, other);
  while (p > 0 && WORD.test(text[p - 1])) p--;
  while (s > 0 && WORD.test(text[text.length - s])) s--;
  return [p, s];
}

/** "old → new" summary, so the change is readable without scrolling the line. */
function changeSummary(edit) {
  let from = edit.summary_before, to = edit.summary_after;
  if (!from || !to) {
    const [p, s] = changedWords(edit.before, edit.after);
    const [q, u] = changedWords(edit.after, edit.before);
    from = edit.before.slice(p, edit.before.length - s).trim();
    to = edit.after.slice(q, edit.after.length - u).trim();
  }
  const row = el("p", "change");
  row.append(el("code", "del", from || "(nothing)"), " → ", el("code", "add", to || "(nothing)"));
  return row;
}

/** Changed part of a line: common prefix and suffix stay plain, the middle is marked. */
function diffLine(text, other, sign) {
  const [p, s] = changedSpan(text, other);
  const row = el("span", sign === "-" ? "del" : "add");
  row.append(el("span", "sign", sign), text.slice(0, p));
  row.append(el("mark", null, text.slice(p, text.length - s)), text.slice(text.length - s), "\n");
  return row;
}

const ATU_STEPS = {
  compile: "Compile the project",
  new_profile: "Create a new profile to get the new defaults",
  rebuild: "Rebuild and check the Exposure Preview",
  export: "Export with Execute and open the package",
};

export function renderRecipes(root, code) {
  for (const r of code.recipes) {
    const card = el("article", "recipe");
    card.append(el("h3", null, r.title), el("p", "why", r.why));
    for (const e of r.edits) {
      const fig = el("figure", "code diff");
      const cap = el("figcaption");
      cap.append(sourceLink(code.repo_url, e.file, e.line), el("span", "lines", `line ${e.line}`), copyButton(e.after.trim()));
      const pre = el("pre");
      pre.append(diffLine(e.before, e.after, "-"), diffLine(e.after, e.before, "+"));
      fig.append(cap, pre);
      card.append(changeSummary(e), fig);
    }
    card.append(trustedHtml(el("p", "result"), r.result));
    const steps = el("ol", "atu-steps");
    for (const s of r.atu) steps.append(el("li", null, ATU_STEPS[s] || s));
    card.append(steps);
    root.append(card);
  }
}
