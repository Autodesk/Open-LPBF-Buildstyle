// Copy button for static code blocks: <figure class="code" data-copy><figcaption>…</figcaption><pre>…</pre></figure>

for (const figure of document.querySelectorAll("figure.code[data-copy]")) {
  const pre = figure.querySelector("pre");
  const caption = figure.querySelector("figcaption");
  if (!pre || !caption) continue;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "copy";
  button.textContent = "Copy";
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(pre.textContent);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Select and copy";
    }
    setTimeout(() => { button.textContent = "Copy"; }, 1600);
  });
  caption.append(button);
}
