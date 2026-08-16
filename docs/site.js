const navToggle = document.querySelector("[data-nav-toggle]");
const nav = document.querySelector("[data-nav]");

navToggle?.addEventListener("click", () => {
  const open = nav?.classList.toggle("is-open") ?? false;
  navToggle.setAttribute("aria-expanded", String(open));
});

nav?.addEventListener("click", (event) => {
  if (!(event.target instanceof HTMLAnchorElement)) return;
  nav.classList.remove("is-open");
  navToggle?.setAttribute("aria-expanded", "false");
});

for (const year of document.querySelectorAll("[data-year]")) {
  year.textContent = String(new Date().getFullYear());
}
