/* Reset page: the email link brings a one-time pass in the address (#access_token=...&type=recovery) */
const resetForm = document.getElementById("resetForm");
const resetStatus = document.getElementById("resetStatus");
const newPass = document.getElementById("newPass");
const resetBtn = document.getElementById("resetBtn");
const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
const recoveryToken = hash.get("access_token") || "";

function say(text, isError) { resetStatus.textContent = text; resetStatus.classList.toggle("is-error", Boolean(isError)); }

document.getElementById("showNew").addEventListener("change", function (e) { newPass.type = e.target.checked ? "text" : "password"; });

if (!recoveryToken) {
  resetBtn.disabled = true;
  say(hash.get("error_description") ? "This link has expired or was already used. Request a new one on the login page." : "Open this page from the link in your reset email.", true);
}

resetForm.addEventListener("submit", async function (event) {
  event.preventDefault();
  resetBtn.disabled = true; say("Saving...", false);
  try {
    await authSetPassword(newPass.value, recoveryToken);
    history.replaceState(null, "", location.pathname);
    say("Password changed. Taking you to log in...", false);
    setTimeout(function () { location.href = "login.html"; }, 1500);
  } catch (error) { say(error.message, true); resetBtn.disabled = false; }
});
