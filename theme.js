/* =========================================================
   THEME + SHELL  (theme.js)
   Loaded in the <head> of every page except the classroom.
   1. Light by default; the learner can switch to dark (remembered on this device).
   2. Adds the top strip (name, theme switch, account) and the bottom menu
      to pages whose <body> has data-nav="home|courses|quizzes".
   The classroom is always dark and does not use this file.
   ========================================================= */
(function () {
  var KEY = "lecturerTheme";
  function savedTheme() { try { return localStorage.getItem(KEY) === "dark" ? "dark" : "light"; } catch (e) { return "light"; } }
  document.documentElement.setAttribute("data-theme", savedTheme());

  var ICONS = {
    home:    '<path d="M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
    courses: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5"/><path d="M9 7h6"/>',
    class:   '<path d="m2 9 10-5 10 5-10 5z"/><path d="M6 11.5V16c0 1.5 3 3 6 3s6-1.5 6-3v-4.5"/>',
    quiz:    '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="m9 9 1.5 1.5L13 8"/><path d="M9 15h6"/>',
    sun:     '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon:    '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>'
  };
  function svg(name) {
    return '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + "</svg>";
  }
  function lastDoc() { try { return localStorage.getItem("lastDocId") || ""; } catch (e) { return ""; } }
  function hasLesson() { try { return !!sessionStorage.getItem("currentLesson"); } catch (e) { return false; } }
  function session() { try { return typeof getSession === "function" ? getSession() : null; } catch (e) { return null; } }

  function build() {
    var page = document.body.getAttribute("data-nav");
    if (!page) return;

    /* ---- top strip ---- */
    var top = document.createElement("header");
    top.className = "shell-top";
    var brand = document.createElement("a");
    brand.className = "shell-brand"; brand.href = "generate.html";
    brand.innerHTML = 'Jay <span>Devo</span> · Lecturer';

    var tools = document.createElement("div");
    tools.className = "shell-tools";

    var toggle = document.createElement("button");
    toggle.type = "button"; toggle.className = "shell-icon";
    function paintToggle() {
      var dark = document.documentElement.getAttribute("data-theme") === "dark";
      toggle.innerHTML = svg(dark ? "sun" : "moon");
      toggle.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
    }
    toggle.addEventListener("click", function () {
      var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem(KEY, next); } catch (e) { /* fine */ }
      paintToggle();
    });
    paintToggle();

    var s = session();
    var user = s && s.user ? s.user : null;
    var avatar = document.createElement(user ? "button" : "a");
    avatar.className = "shell-avatar";
    if (user) {
      avatar.type = "button";
      avatar.textContent = String(user.name || user.email || "?").trim().charAt(0).toUpperCase();
      avatar.setAttribute("aria-label", "Your account");
      var menu = document.createElement("div");
      menu.className = "shell-menu"; menu.hidden = true;
      var who = document.createElement("p");
      who.textContent = user.name || user.email;
      var out = document.createElement("button");
      out.type = "button"; out.textContent = "Log out";
      out.addEventListener("click", async function () {
        try { await authLogOut(); } catch (e) { /* fine */ }
        window.location.href = "generate.html";
      });
      menu.append(who, out);
      avatar.addEventListener("click", function (ev) { ev.stopPropagation(); menu.hidden = !menu.hidden; });
      document.addEventListener("click", function () { menu.hidden = true; });
      tools.append(toggle, avatar, menu);
    } else {
      avatar.href = "login.html"; avatar.textContent = "Log in"; avatar.className = "shell-login";
      tools.append(toggle, avatar);
    }
    var fbUrl = window.APP_CONFIG && window.APP_CONFIG.feedbackUrl;
    if (fbUrl) {
      var fb = document.createElement("a");
      fb.className = "shell-feedback"; fb.href = fbUrl; fb.target = "_blank"; fb.rel = "noopener";
      fb.textContent = "Feedback";
      tools.prepend(fb);
    }
    top.append(brand, tools);
    document.body.prepend(top);

    /* ---- greeting on the home page ---- */
    var greet = document.getElementById("pageGreeting");
    if (greet) {
      var h = new Date().getHours();
      var part = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
      var first = user && user.name ? String(user.name).trim().split(/\s+/)[0] : "";
      greet.textContent = first ? part + ", " + first : "Welcome";
    }
    var cont = document.getElementById("continueCard");
    if (cont && lastDoc()) { cont.href = "outline.html?doc=" + encodeURIComponent(lastDoc()); cont.hidden = false; }

    /* ---- bottom menu ---- */
    var doc = lastDoc();
    var items = [
      { key: "home",    label: "Home",      icon: "home",    href: "generate.html" },
      { key: "courses", label: "Courses",   icon: "courses", href: doc ? "outline.html?doc=" + encodeURIComponent(doc) : "generate.html#savedCard" },
      { key: "class",   label: "Classroom", icon: "class",   href: hasLesson() ? "classroom.html" : (doc ? "outline.html?doc=" + encodeURIComponent(doc) : "generate.html") },
      { key: "quizzes", label: "Quizzes",   icon: "quiz",    href: doc ? "outline.html?doc=" + encodeURIComponent(doc) : "generate.html" }
    ];
    var nav = document.createElement("nav");
    nav.className = "shell-nav"; nav.setAttribute("aria-label", "Main menu");
    items.forEach(function (it) {
      var a = document.createElement("a");
      a.href = it.href;
      if (it.key === page) a.className = "is-on";
      a.innerHTML = svg(it.icon) + "<span>" + it.label + "</span>";
      nav.append(a);
    });
    document.body.append(nav);
    document.body.classList.add("has-nav");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build); else build();
})();
