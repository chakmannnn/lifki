// Supabase integration for the existing Lifki frontend.
// This file adds behavior only. It does not add CSS or rewrite index.html.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const config = {
  SUPABASE_URL: "https://ujxfpljkenehnfdsdbch.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVqeGZwbGprZW5laG5mZHNkYmNoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIzOTQ2ODgsImV4cCI6MjEwNzk3MDY4OH0.AnaW3FzkUrZzvCNP6VkMVX1aUS__T8Z2MkLZDpFGlwI",
  WHOP_CHECKOUT_URL: "https://sandbox.whop.com/checkout/plan_TRYcDJCFaxZcX",
  WIDGET_URL: "https://ujxfpljkenehnfdsdbch.supabase.co/storage/v1/object/public/lifki/WIDGETT.JS",
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
let checkoutReturnPending = false;
try {
  const params = new URLSearchParams(window.location.search);
  const status = params.get("status") || params.get("payment_status");
  checkoutReturnPending = status === "success" || status === "succeeded" || params.get("checkout") === "success";
  if (checkoutReturnPending) sessionStorage.setItem("lifkiCheckoutReturn", "1");
  else checkoutReturnPending = sessionStorage.getItem("lifkiCheckoutReturn") === "1";
} catch (error) {}

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

function ensureActivationCard() {
  if (!user) return;
  const main = $("#appMain");
  if (!main || main.querySelector("[data-account-activation]")) return;
  const active = subscription?.subscription_status === "active";
  main.insertAdjacentHTML("afterbegin", `<section class="app-card" data-account-activation><h3>Activate your workspace</h3><p>${active ? "Your workspace is active and your finished bubble is ready to install." : "Activate your account to receive the finished chat bubble installation code."}</p>${active ? "" : "<div class=\"app-page-actions\"><button class=\"app-primary-btn\" type=\"button\" data-whop-checkout>Activate Your Bubble / Subscribe Now</button></div>"}</section>`);
}

function bindAccountNavigation() {
  $("#appShell")?.querySelectorAll("[data-app-view]").forEach((button) => {
    button.onclick = () => {
      const view = button.dataset.appView;
      if (view === "dashboard") {
        renderCurrentState();
        return;
      }
      if (subscription?.subscription_status === "active") {
        renderPaidSection(view);
        return;
      }
      if (typeof window.renderAppView === "function") {
        window.renderAppView(view);
        // Keep the signed-in workspace activation card visible on every account section.
        ensureActivationCard();
        // The existing renderer rebinds its own controls; rebind this
        // integration afterward so Dashboard returns to the real account state.
        bindAccountNavigation();
        bindAccountActions();
      }
    };
  });
}

let whopCheckoutInstance = null;

async function openWhopCheckoutIframe() {
  document.querySelector("#lifkiWhopCheckoutModal")?.remove();
  const checkoutUrl = new URL(config.WHOP_CHECKOUT_URL);
  const planId = checkoutUrl.pathname.match(/plan_[A-Za-z0-9_-]+/)?.[0];
  const successUrl = config.WHOP_SUCCESS_URL || `${window.location.origin}${window.location.pathname}?status=success`;
  if (!planId) {
    window.alert("The Whop plan ID is not configured.");
    return;
  }
  const modal = document.createElement("section");
  modal.className = "auth-modal";
  modal.id = "lifkiWhopCheckoutModal";
  modal.innerHTML = `<div class="auth-card" style="width:min(760px,100%);max-height:calc(100vh - 32px);overflow:auto"><div class="head-row"><div class="mini-brand"><i></i> Lifki checkout</div><button class="close-widget" type="button" data-close-whop-checkout aria-label="Close checkout">×</button></div><h2>Activate your workspace.</h2><p>Complete your Whop subscription below. Your account will update after the webhook confirms payment.</p><div id="lifkiWhopCheckoutFrame" style="min-height:620px"></div></div>`;
  document.body.appendChild(modal);
  modal.querySelector("[data-close-whop-checkout]")?.addEventListener("click", () => modal.remove());
  const frame = modal.querySelector("#lifkiWhopCheckoutFrame");
  try {
    if (!window.WhopElements) {
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://cdn.whop.com/elements/amber/elements.js";
        script.setAttribute("data-whop-elements", "");
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
      });
    }
    const elements = window.WhopElements({ environment: config.WHOP_CHECKOUT_EMBED_ENVIRONMENT || "production" });
    whopCheckoutInstance = elements.checkout.create({
      plan: planId,
      returnUrl: successUrl,
      metadata: { email: user?.email || "", user_id: user?.id || "" },
      onComplete: (completion) => {
        if (completion?.result === "payment") {
          try { sessionStorage.setItem("lifkiCheckoutReturn", "1"); } catch (error) {}
          window.location.assign(successUrl);
        }
      }
    });
    whopCheckoutInstance.create("checkout").mount("#lifkiWhopCheckoutFrame");
  } catch (error) {
    console.error("Whop iframe checkout failed", error);
    if (frame) frame.innerHTML = `<p class="auth-error show">Checkout could not load. Please try again.</p>`;
  }
}

window.LifkiOpenWhopCheckoutIframe = openWhopCheckoutIframe;

function requestCancellationConfirmation(endDate) {
  return new Promise((resolve) => {
    document.querySelector("#lifkiCancelConfirm")?.remove();
    const modal = document.createElement("section");
    modal.className = "auth-modal";
    modal.id = "lifkiCancelConfirm";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.innerHTML = `<div class="auth-card paid-cancel-confirm-card"><div class="head-row"><div class="mini-brand"><i></i> Lifki billing</div><button class="close-widget" type="button" data-cancel-no aria-label="Keep subscription">×</button></div><h2>Cancel subscription?</h2><p>Your automatic renewal will be stopped. You will keep access until ${escapeHtml(endDate)}.</p><div class="auth-actions"><button class="auth-cancel" type="button" data-cancel-no>No, keep it</button><button class="paid-confirm-btn" type="button" data-cancel-yes>Yes, cancel</button></div></div>`;
    document.body.appendChild(modal);
    const finish = (value) => { modal.remove(); resolve(value); };
    modal.querySelectorAll("[data-cancel-no]").forEach((element) => element.addEventListener("click", () => finish(false)));
    modal.querySelector("[data-cancel-yes]")?.addEventListener("click", () => finish(true));
  });
}

async function cancelWorkspaceSubscription(button) {
  if (!user || !subscription?.whop_membership_id) {
    window.alert("No active Whop membership is linked to this account.");
    return;
  }
  const endDate = date(subscription.current_period_end);
  const confirmed = await requestCancellationConfirmation(endDate);
  if (!confirmed) return;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Requesting cancellation…";
  try {
    const result = await supabase.functions.invoke(config.WHOP_CANCEL_FUNCTION_NAME || "cancel-whop-membership", {
      body: {},
    });
    if (result.error) throw result.error;
    const response = result.data || {};
    if (response.error) throw new Error(response.error);
    button.textContent = "Cancellation requested";
    button.classList.add("is-requested");
    const note = button.parentElement?.querySelector("[data-cancel-note]");
    if (note) note.textContent = `Automatic renewal is off. Access remains until ${endDate}.`;
  } catch (error) {
    console.error("Subscription cancellation failed", error);
    button.disabled = false;
    button.textContent = original;
    window.alert(error?.message || "Cancellation could not be completed. Please try again.");
  }
}

function bindAccountActions() {
  bindAccountNavigation();
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
    button.onclick = () => { void openWhopCheckoutIframe(); };
  });
  $("#appMain")?.querySelectorAll("[data-cancel-workspace]").forEach((button) => {
    button.onclick = () => { void cancelWorkspaceSubscription(button); };
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

function revealCheckoutSuccess() {
  if (!checkoutReturnPending || !user) return;
  const main = $("#appMain");
  if (!main) return;
  main.querySelector("[data-checkout-success]")?.remove();
  const integrationCard = [...main.querySelectorAll(".app-card")].find((card) => card.querySelector("h3")?.textContent?.trim() === "Integration Code");
  const message = integrationCard
    ? "Operation succeeded. Your workspace is active and your Integration Code is ready below."
    : "Operation succeeded. We are confirming your workspace before showing the Integration Code.";
  main.insertAdjacentHTML("afterbegin", `<section class="app-card" data-checkout-success><h3>Operation succeeded</h3><p>${message}</p></section>`);
  if (integrationCard) {
    integrationCard.scrollIntoView({ behavior: "smooth", block: "start" });
    checkoutReturnPending = false;
    try { sessionStorage.removeItem("lifkiCheckoutReturn"); } catch (error) {}
  }
}

function unpaidView() {
  // Use the original account renderer unchanged for the normal pre-subscription UI.
  if (typeof window.renderAppView === "function") {
    window.renderAppView("dashboard");
    bindAccountNavigation();
    bindAccountActions();
  }
}

function renderPaidSection(view = "dashboard") {
  const record = subscription;
  if (!record || record.subscription_status !== "active") {
    renderCurrentState();
    return;
  }
  if (typeof window.renderAppView !== "function") return;
  window.renderAppView(view);
  const main = $("#appMain");
  if (!main) return;
  if (view === "dashboard") {
    // Keep the exact original Dashboard markup. Move the account controls to
    // the top, then replace only the original checkout card content.
    const activation = main.querySelector("[data-account-activation]");
    const topLine = main.querySelector(".app-topline");
    if (activation && topLine && topLine.nextElementSibling !== activation) topLine.after(activation);
    const metricGrid = main.querySelector(".app-metric-grid");
    metricGrid?.classList.add("paid-metrics-card");
    const metricCards = main.querySelectorAll(".app-metric-card");
    metricCards[0]?.querySelector("strong")?.replaceChildren(document.createTextNode("$0"));
    metricCards[0]?.querySelector("small")?.replaceChildren(document.createTextNode("0 current leads"));
    metricCards[1]?.querySelector("strong")?.replaceChildren(document.createTextNode("0"));
    metricCards[1]?.querySelector("small")?.replaceChildren(document.createTextNode("0 current leads"));
    main.querySelectorAll(".app-card").forEach((card) => {
      const title = card.querySelector("h3")?.textContent?.trim();
      if (title === "Recent leads") {
        const list = card.querySelector(".app-lead-list");
        list?.replaceChildren();
        const description = card.querySelector("p");
        if (description) description.textContent = "0 current leads. Real leads will appear here when received.";
      }
      if (title === "Pricing settings") card.remove();
    });
    if (activation) {
      activation.classList.add("paid-workspace-card");
      activation.innerHTML = `<div class="paid-workspace-top"><div class="paid-workspace-copy"><h3>Workspace activation</h3></div><div class="paid-status-list"><div class="paid-status-item"><span>Workspace status</span><strong class="is-active">${escapeHtml(record.subscription_status)}</strong></div><div class="paid-status-item"><span>Access through</span><strong>${escapeHtml(date(record.current_period_end))}</strong></div></div></div><div class="paid-workspace-actions"><span class="paid-cancel-note" data-cancel-note>Cancel automatic renewal.</span><button class="paid-cancel-btn" type="button" data-cancel-workspace>Cancel subscription</button></div>`;
      activation.insertAdjacentHTML("afterend", `<div class="paid-dashboard-gap" aria-hidden="true"></div><section class="app-card paid-integration-card"><div class="paid-code-head"><div><div class="paid-card-kicker">Installation</div><h3>Integration Code</h3></div><span class="paid-code-badge">Ready to install</span></div><p>Copy and paste this code once into your website.</p><div class="field"><textarea readonly rows="9" aria-label="Integration Code">${escapeHtml(codeFor(record.id))}</textarea></div><div class="app-page-actions"><button class="app-primary-btn" type="button" data-copy-code="${escapeHtml(codeFor(record.id))}">Copy Code</button></div></section><div class="paid-dashboard-after-install-gap" aria-hidden="true"></div>`);
    }
  } else if (view === "leads") {
    // Keep the original Leads page structure while hiding demo rows.
    const tableBody = main.querySelector(".app-table tbody");
    tableBody?.replaceChildren();
    tableBody?.insertAdjacentHTML("beforeend", `<tr><td colspan="6">0 current leads</td></tr>`);
    const leadIntro = main.querySelector(".app-page-head p");
    if (leadIntro) leadIntro.textContent = "0 current leads. Real leads will appear here when received.";
    main.querySelector(".lead-detail-card")?.remove();
  }
  ensureActivationCard();
  bindAccountNavigation();
  bindAccountActions();
}

function paidView() {
  renderPaidSection("dashboard");
}

function renderCurrentState() {
  if (!user) return;
  if (subscription?.subscription_status === "active") paidView();
  else unpaidView();
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
  if (renderedSubscriptionState === nextState) {
    if (nextState === "active") revealCheckoutSuccess();
    return;
  }
  renderedSubscriptionState = nextState;
  renderCurrentState();
  if (nextState === "active") revealCheckoutSuccess();
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
    closeAuth();
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
    return;
  }
  closeAuth();
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
  closeAuth();
  await loadSubscription(user);
  startSubscriptionPolling();
} else if (config.AUTO_OPEN_AUTH) {
  openAuth("signin");
}
