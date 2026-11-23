/* =========================================================
   SETTINGS FOR THE WEBSITE (config.js)
   Fill in the Render address ONCE, here. The other files never need it again,
   so replacing common.js or any other file will not wipe your address.
   ========================================================= */
window.APP_CONFIG = {
  // Your Render server address (no slash at the end), e.g. "https://ai-lecturer-abcd.onrender.com"
  serverUrl: "https://ai-lecturer-b0qs.onrender.com",

  // Supabase (accounts). These two are meant to be public, they are safe to keep here.
  supabaseUrl: "https://mppvarjcljjprwkblrib.supabase.co",
  supabaseKey: "sb_publishable_cufG2ZRMvekuk6mBif-AlQ_ZGZWhlqq",

  // Your Google Form link for feedback. Leave "" and the Feedback link stays hidden.
  feedbackUrl: "",

  // Where the "reset password" email sends people (must also be added in Supabase > Authentication > URL Configuration)
  resetPageUrl: "https://jaydevo1.github.io/ai-lecturer/reset.html"
};
