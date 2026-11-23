/* =========================================================
   LOGIN PAGE (login.js)
   Log in, create an account, or leave as a guest (the link at the bottom of the page).
   common.js provides: authLogIn, authSignUp, authLogOut, getSession, claimGuestData, accountsReady
   ========================================================= */
const tabLogin = document.getElementById("tabLogin");
const tabSignup = document.getElementById("tabSignup");
const authForm = document.getElementById("authForm");
const nameField = document.getElementById("nameField");
const nameInput = document.getElementById("nameInput");
const emailInput = document.getElementById("emailInput");
const passwordInput = document.getElementById("passwordInput");
const authBtn = document.getElementById("authBtn");
const authStatus = document.getElementById("authStatus");
const alreadyCard = document.getElementById("alreadyCard");
const formCard = document.getElementById("formCard");

let mode = "login";      // "login" or "signup"

function showStatus(text, isError) {
  authStatus.textContent = text;
  authStatus.classList.toggle("is-error", Boolean(isError));
}

function setMode(newMode) {
  mode = newMode;
  tabLogin.classList.toggle("is-on", mode === "login");
  tabSignup.classList.toggle("is-on", mode === "signup");
  nameField.hidden = mode !== "signup";
  nameInput.required = mode === "signup";
  authBtn.textContent = mode === "signup" ? "Create account" : "Log in";
  passwordInput.autocomplete = mode === "signup" ? "new-password" : "current-password";
  document.getElementById("forgotBtn").hidden = mode !== "login";
  showStatus("", false);
}

document.getElementById("forgotBtn").addEventListener("click", async function () {
  const email = emailInput.value.trim();
  if (!accountsReady()) { showStatus("Accounts are not set up yet.", true); return; }
  if (!email) { showStatus("Type your email above first, then tap Forgot password.", true); return; }
  showStatus("Sending...", false);
  try {
    await authRecover(email);
    showStatus("If that email has an account, a reset link is on its way. Check your inbox (and spam).", false);
  } catch (error) { showStatus(error.message, true); }
});

tabLogin.addEventListener("click", function () { setMode("login"); });
tabSignup.addEventListener("click", function () { setMode("signup"); });

document.getElementById("showPassword").addEventListener("change", function (event) {
  passwordInput.type = event.target.checked ? "text" : "password";
});

authForm.addEventListener("submit", async function (event) {
  event.preventDefault();
  if (!accountsReady()) { showStatus("Accounts are not set up yet.", true); return; }

  const email = emailInput.value.trim();
  const password = passwordInput.value;
  authBtn.disabled = true;
  showStatus(mode === "signup" ? "Creating your account..." : "Logging in...", false);

  try {
    if (mode === "signup") {
      const name = nameInput.value.trim();
      if (!name) throw new Error("Please type your name.");
      const result = await authSignUp(name, email, password);
      if (result.needsConfirm) {
        showStatus("Almost done: we sent a link to " + email + ". Open it, then come back and log in.", false);
        authBtn.disabled = false;
        return;
      }
    } else {
      await authLogIn(email, password);
    }
    showStatus("Done! Moving your saved material to your account...", false);
    await claimGuestData();                  // PDFs and progress this browser already had
    window.location.href = "generate.html";
  } catch (error) {
    showStatus(error.message, true);
    authBtn.disabled = false;
  }
});

// Already logged in? Say so instead of showing the form.
const session = getSession();
if (session && session.user) {
  document.getElementById("alreadyText").textContent = "You are logged in as " + (session.user.name || session.user.email) + ".";
  alreadyCard.hidden = false;
  formCard.hidden = true;
  document.getElementById("logoutBtn").addEventListener("click", async function () {
    await authLogOut();
    window.location.reload();
  });
}

if (!accountsReady()) showStatus("Accounts are not set up yet. You can still continue as a guest.", true);
