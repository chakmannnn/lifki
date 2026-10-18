// Supabase integration for the existing Lifki frontend.
// This file adds behavior only. It does not add CSS or rewrite index.html.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const config = {
  SUPABASE_URL: "https://uyzhunhiijswxnvdiuqt.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV5emh1bmhpaWpzd3hudmRpdXF0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIyOTA2NzMsImV4cCI6MjEwNzg2NjY3M30.MgMzR3HA4ME3xN_bnMGnVQdGULDOUpjygWVLvIkDi4Y",
  WHOP_CHECKOUT_URL: "https://sandbox.whop.com/checkout/plan_dkC2f7iEPp3QF",
  WIDGET_URL: "https://uyzhunhiijswxnvdiuqt.supabase.co/storage/v1/object/public/lifki/lifki.js",
  AUTO_OPEN_AUTH: true,
  ...(window.LifkiDashboardConfig || {})
};

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

const $ = (selector) => document.querySelector(selector);
const authModal = $("#authModal");
const authForm = $("#signupForm");
const authError = $("#signupError");
let mode = "signin";
let user = null;
let subscription = null;
let renderedSubscriptionState = null;
let subscriptionPollTimer = null;

function message(value = "") {
  if (!authError) return;
  authError.textContent = value;
  authError.classList.toggle("show", Boolean(value));
}

function setMode(nextMode) {
  mode = nextMode === "signup" ? "signup" : "signin";
  $("#authTitle")?.replaceChildren(document.createTextNode(mode === "signin" ? "Welcome back to Lifki." : "Create your Lifki account."));
  $("#authSubhead")?.replaceChildren(document.createTextNode(mode === "signin"
    ? "Sign in to continue to your remodeler workspace."
    : "Use the same email for your Lifki and Whop accounts."));
  if ($("#authSubmit")) $("#authSubmit").textContent = mode === "signin" ? "Sign in →" : "Create account →";
  if ($("#authModeToggle")) $("#authModeToggle").textContent = mode === "signin" ? "Need an account? Create one" : "Already have an account? Sign in";
  const password = authForm?.querySelector("input[name=password]");
  if (password) password.autocomplete = mode === "signin" ? "current-password" : "new-password";
  message("");
}

function openAuth(nextMode = "signin") {
  setMode(nextMode);
  authModal?.classList.remove("hidden");
  authForm?.querySelector("input[name=email]")?.focus();
}

function closeAuth() {
  authModal?.classList.add("hidden");
  message("");
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function date(value) {
  if (!value) return "Not provided";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric"
  });
}

function codeFor(subscriptionId) {
  const widgetUrl = config.WIDGET_URL || "https://supabase.co";
  return `<!-- Copy and paste this code once into your website -->
<script>
  window.MyChatWidgetConfig = { appId: '${subscriptionId}' };
  (function() {
    var d = document, s = d.createElement('script');
    s.src = '${widgetUrl}';
    s.async = true;
    d.getElementsByTagName('head').appendChild(s);
  })();
</script>`;
}

function bindAccountActions() {
  $("#appMain")?.querySelectorAll("[data-dashboard-signout]").forEach((button) => {
    button.onclick = () => supabase.auth.signOut();
  });
  $("#appMain")?.querySelectorAll("[data-copy-code]").forEach((button) => {
    button.onclick = async () => {
      const value = button.dataset.copyCode || "";
      try {
        await navigator.clipboard.writeText(value);
        const original = button.textContent;
        button.textContent = "Copied";
        setTimeout(() => { button.textContent = original; }, 1400);
      } catch {
        $("#appMain textarea")?.select();
      }
    };
  });
  $("#appMain")?.querySelectorAll("[data-whop-checkout]").forEach((button) => {
    button.onclick = () => {
      const checkout = new URL(config.WHOP_CHECKOUT_URL);
      checkout.searchParams.set("email", user?.email || "");
      checkout.searchParams.set("user_id", user?.id || "");
      const whop = window.Whop || window.whop;
      if (whop && typeof whop.openCheckout === "function") {
        whop.openCheckout({
          checkoutUrl: checkout.toString(),
          email: user?.email,
          metadata: { email: user?.email || "", user_id: user?.id || "" }
        });
      } else {
        window.location.assign(checkout.toString());
      }
    };
  });
}

function render(html) {
  const main = $("#appMain");
  const shell = $("#appShell");
  if (!main || !shell) return;
  main.innerHTML = html;
  shell.classList.remove("hidden");
  closeAuth();
  bindAccountActions();
}

function unpaidView() {
  const email = escapeHtml(user?.email || "");
  render(`<div class="app-topline"><small>${email} · Lifki workspace</small><button class="app-signout" type="button" data-dashboard-signout>Sign out</button></div>
    <div class="app-page-head"><div class="eyebrow">Your remodeler workspace</div><h1>See your quoting system before you connect it.</h1><p>Preview examples are shown until an active Whop subscription is linked to this account.</p></div>
    <div class="app-metric-grid"><div class="app-metric-card"><span>Quote requests</span><strong>24</strong><small>Preview activity this month</small></div><div class="app-metric-card"><span>Average quote value</span><strong>$28.4k</strong><small>Mock dashboard example</small></div><div class="app-metric-card"><span>Follow-ups ready</span><strong>7</strong><small>Mock lead queue</small></div></div>
    <div class="app-content-grid"><section class="app-card"><h3>Recent quote activity</h3><p>Mock data is shown until the subscription becomes active.</p><div class="app-lead-list"><div class="app-lead-row"><div><strong>Kitchen + Bath remodel</strong><small>New lead · 2 minutes ago</small></div><span class="app-lead-value">$42k–$51k</span></div><div class="app-lead-row"><div><strong>Kitchen · Full Gut</strong><small>Follow-up needed · Today</small></div><span class="app-lead-value">$26k–$31k</span></div><div class="app-lead-row"><div><strong>Bath · Hybrid Refresh</strong><small>Quote viewed · Yesterday</small></div><span class="app-lead-value">$18k–$24k</span></div></div></section><section class="app-card"><h3>Activate your workspace</h3><p>Whop will use this signed-in email to connect billing to your Lifki account.</p><div class="app-lead-list"><div class="app-lead-row"><div><strong>Email</strong><small>${email}</small></div></div><div class="app-lead-row"><div><strong>Status</strong><small>Not active</small></div></div></div><div class="app-page-actions"><button class="app-primary-btn" type="button" data-whop-checkout>Activate Your Bubble / Subscribe Now</button></div></section></div>`);
}

function paidView() {
  const record = subscription;
  const rawCode = codeFor(record.id);
  render(`<div class="app-topline"><small>${escapeHtml(user?.email || "")} · Lifki workspace</small><button class="app-signout" type="button" data-dashboard-signout>Sign out</button></div>
    <div class="app-page-head"><div class="eyebrow">Live subscription</div><h1>Your raw account.</h1><p>Mockup data is hidden. The values below are read from your active subscription record.</p></div>
    <div class="app-metric-grid"><div class="app-metric-card"><span>Subscription status</span><strong>${escapeHtml(record.subscription_status)}</strong><small>Current database state</small></div><div class="app-metric-card"><span>Current period ends</span><strong>${escapeHtml(date(record.current_period_end))}</strong><small>Whop membership period</small></div><div class="app-metric-card"><span>Account email</span><strong>${escapeHtml(user?.email || "")}</strong><small>Supabase Auth identity</small></div></div>
    <div class="app-content-grid"><section class="app-card"><h3>Subscription record</h3><p>Raw values returned for this authenticated account.</p><div class="app-lead-list"><div class="app-lead-row"><div><strong>subscriptions.id / appId</strong><small>${escapeHtml(record.id)}</small></div></div><div class="app-lead-row"><div><strong>user_id</strong><small>${escapeHtml(record.user_id)}</small></div></div><div class="app-lead-row"><div><strong>whop_membership_id</strong><small>${escapeHtml(record.whop_membership_id || "Not provided")}</small></div></div><div class="app-lead-row"><div><strong>updated_at</strong><small>${escapeHtml(date(record.updated_at))}</small></div></div></div></section><section class="app-card"><h3>Integration Code</h3><p>Copy and paste this code once into your website.</p><div class="field"><textarea readonly rows="9" aria-label="Integration Code">${escapeHtml(rawCode)}</textarea></div><div class="app-page-actions"><button class="app-primary-btn" type="button" data-copy-code="${escapeHtml(rawCode)}">Copy Code</button></div></section></div>`);
}

async function loadSubscription(currentUser) {
  if (!currentUser) return;
  const result = await supabase.from("subscriptions")
    .select("id,user_id,whop_membership_id,subscription_status,current_period_end,updated_at")
    .eq("user_id", currentUser.id).maybeSingle();
  if (result.error) {
    console.error("Subscription lookup failed", result.error);
    return;
  }
  const nextSubscription = result.data || null;
  const nextState = nextSubscription?.subscription_status === "active" ? "active" : "unpaid";
  subscription = nextSubscription;
  // Only replace the dashboard when the state changes. This keeps the user's
  // current screen stable while polling for the Whop webhook update.
  if (renderedSubscriptionState === nextState) return;
  renderedSubscriptionState = nextState;
  if (nextState === "active") paidView();
  else unpaidView();
}

function stopSubscriptionPolling() {
  if (subscriptionPollTimer) window.clearInterval(subscriptionPollTimer);
  subscriptionPollTimer = null;
}

function startSubscriptionPolling() {
  stopSubscriptionPolling();
  subscriptionPollTimer = window.setInterval(() => {
    if (user) void loadSubscription(user);
  }, 10000);
}

async function submitAuth(event) {
  event.preventDefault();
  event.stopImmediatePropagation();
  message("");
  const formData = new FormData(authForm);
  const email = String(formData.get("email") || "").trim().toLowerCase();
  const password = String(formData.get("password") || "");
  if (!/^\S+@\S+\.\S+$/.test(email)) return message("Enter a valid email address.");
  if (password.length < 6) return message("Password must be at least 6 characters.");
  const submit = $("#authSubmit");
  if (submit) submit.disabled = true;
  try {
    const result = mode === "signin"
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password, options: { data: { email } } });
    if (result.error) throw result.error;
    if (mode === "signup" && !result.data.session) {
      setMode("signin");
      return message("Account created. Check your email to confirm it, then sign in.");
    }
    user = result.data.user;
    renderedSubscriptionState = null;
    await loadSubscription(user);
    startSubscriptionPolling();
  } catch (error) {
    message(`${mode === "signin" ? "Sign in" : "Sign up"} failed: ${error?.message || "Please try again."}`);
  } finally {
    if (submit) submit.disabled = false;
  }
}

// Capture the existing preview form so its local mock handler does not also run.
authForm?.addEventListener("submit", submitAuth, { capture: true });
$("#authModeToggle")?.addEventListener("click", (event) => {
  event.stopImmediatePropagation();
  setMode(mode === "signin" ? "signup" : "signin");
}, { capture: true });
$("#cancelAuth")?.addEventListener("click", closeAuth);
$("#closeAuth")?.addEventListener("click", closeAuth);

// Connect the existing homepage account buttons without changing their styles.
document.querySelectorAll("[data-open-signin]").forEach((button) => {
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    openAuth("signin");
  }, { capture: true });
});
document.querySelectorAll("[data-open-signup]").forEach((button) => {
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    openAuth("signup");
  }, { capture: true });
});

supabase.auth.onAuthStateChange((_event, session) => {
  user = session?.user || null;
  if (!user) {
    stopSubscriptionPolling();
    subscription = null;
    renderedSubscriptionState = null;
    $("#appShell")?.classList.add("hidden");
    openAuth("signin");
    return;
  }
  renderedSubscriptionState = null;
  void loadSubscription(user).then(startSubscriptionPolling);
});

window.LifkiSupabaseDashboard = {
  supabase,
  openSignIn: () => openAuth("signin"),
  openSignUp: () => openAuth("signup"),
  refresh: () => user && loadSubscription(user)
};

const session = await supabase.auth.getSession();
user = session.data.session?.user || null;
if (user) {
  await loadSubscription(user);
  startSubscriptionPolling();
} else if (config.AUTO_OPEN_AUTH) {
  openAuth("signin");
}
