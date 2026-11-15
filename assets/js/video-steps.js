// Clickable step list next to a demo video, built from <video>.chapters.json (written by tools/render_video.py).
// Usage: <video data-chapters="../assets/video/x.chapters.json"> and <ol class="steps" data-for="videoId">.

function fmt(t) {
  const s = Math.floor(t);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

async function setup(list) {
  const video = document.getElementById(list.dataset.for);
  if (!video || !video.dataset.chapters) return;
  const res = await fetch(video.dataset.chapters);
  if (!res.ok) return;
  const { chapters } = await res.json();
  const items = chapters.map((c) => {
    const li = document.createElement("li");
    const text = document.createElement("span");
    text.textContent = c.caption;
    const time = document.createElement("time");
    time.textContent = fmt(c.t);
    li.append(text, time);
    li.addEventListener("click", () => {
      video.currentTime = c.t + 0.05;
      video.play();
    });
    list.append(li);
    return li;
  });
  video.addEventListener("timeupdate", () => {
    let current = 0;
    chapters.forEach((c, i) => { if (video.currentTime >= c.t) current = i; });
    items.forEach((li, i) => li.classList.toggle("current", i === current));
  });
}

document.querySelectorAll("ol.steps[data-for]").forEach(setup);
