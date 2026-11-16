// Tab switcher for the videos in the overview hero. A hidden video is stopped: a local one is paused,
// a Wistia iframe is reloaded (it cannot be paused from here without the Wistia player API).
(function () {
  const tabs = Array.from(document.querySelectorAll(".hv-tabs [role=tab]"));

  function stop(panel) {
    const video = panel.querySelector("video");
    if (video) video.pause();
    const frame = panel.querySelector("iframe");
    if (frame) frame.src = frame.src;
  }

  function select(tab) {
    for (const t of tabs) {
      const panel = document.getElementById(t.getAttribute("aria-controls"));
      const on = t === tab;
      if (!on && !panel.hidden) stop(panel);
      t.setAttribute("aria-selected", on ? "true" : "false");
      panel.hidden = !on;
    }
  }

  for (const tab of tabs) tab.addEventListener("click", () => select(tab));
})();
