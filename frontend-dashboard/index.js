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

function normalizeWebsiteDomain(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return parsed.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  } catch {
    return "";
  }
}

function codeFor() {
  const widgetUrl = config.WIDGET_URL || "https://supabase.co";
  return `<!-- Copy and paste this one line once into your website -->
<script src="${widgetUrl}" defer></script>`;
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

let whopPaymentHandle = null;
let whopElementsInstance = null;

function lifkiPlanId() {
  try {
    const checkoutUrl = new URL(config.WHOP_CHECKOUT_URL);
    return checkoutUrl.pathname.match(/plan_[A-Za-z0-9_-]+/)?.[0] || "";
  } catch {
    return "";
  }
}

function closeLifkiPayment(modal) {
  try { whopPaymentHandle?.destroy?.(); } catch (error) {}
  whopPaymentHandle = null;
  whopElementsInstance = null;
  modal?.remove();
}

async function openWhopCheckoutIframe() {
  document.querySelector("#lifkiWhopCheckoutModal")?.remove();
  const planId = lifkiPlanId();
  const successUrl = config.WHOP_SUCCESS_URL || `${window.location.origin}${window.location.pathname}?status=success`;
  if (!planId || planId.includes("YOUR_")) {
    window.alert("The Whop plan ID is not configured.");
    return;
  }

  const modal = document.createElement("section");
  modal.className = "auth-modal";
  modal.id = "lifkiWhopCheckoutModal";
  modal.innerHTML = `<style>
    .lifki-payment-card { width:min(980px,100%); max-height:calc(100vh - 28px); overflow:auto; padding:0; border:1px solid rgba(23,70,50,.12); box-shadow:0 24px 80px rgba(16,42,31,.2); background:#fbfaf5; }
    .lifki-payment-shell { display:grid; grid-template-columns:minmax(260px,.86fr) minmax(360px,1.14fr); min-height:640px; }
    .lifki-payment-story { padding:42px 34px; color:#f8fbf5; background:linear-gradient(145deg,#174632 0%,#0f3828 68%,#0c2f23 100%); position:relative; overflow:hidden; }
    .lifki-payment-story:after { content:""; position:absolute; width:260px; height:260px; right:-130px; bottom:-120px; border:1px solid rgba(191,242,117,.25); border-radius:50%; box-shadow:0 0 0 28px rgba(191,242,117,.05),0 0 0 58px rgba(191,242,117,.035); }
    .lifki-payment-kicker { color:#bff275; font-size:11px; font-weight:800; letter-spacing:.12em; text-transform:uppercase; }
    .lifki-payment-story h2 { margin:18px 0 14px; color:#fff; font-size:clamp(26px,3vw,40px); line-height:1.04; letter-spacing:-.045em; }
    .lifki-payment-story p { margin:0; color:rgba(247,251,245,.76); line-height:1.65; }
    .lifki-payment-benefits { display:grid; gap:13px; margin:30px 0 0; padding:0; list-style:none; position:relative; z-index:1; }
    .lifki-payment-benefits li { display:flex; align-items:flex-start; gap:10px; color:rgba(247,251,245,.92); font-size:13px; line-height:1.45; }
    .lifki-payment-check { flex:0 0 20px; width:20px; height:20px; display:grid; place-items:center; border-radius:50%; color:#173f2c; background:#bff275; font-size:12px; font-weight:900; }
    .lifki-payment-note { margin-top:34px !important; padding-top:22px; border-top:1px solid rgba(255,255,255,.14); font-size:12px; }
    .lifki-payment-form { padding:28px clamp(22px,4vw,46px) 34px; background:#fffefa; }
    .lifki-payment-top { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:28px; }
    .lifki-payment-top .mini-brand { margin:0; }
    .lifki-payment-step { color:#73907e; font-size:11px; font-weight:800; letter-spacing:.1em; text-transform:uppercase; }
    .lifki-payment-form h3 { margin:0 0 7px; color:#163f2d; font-size:26px; letter-spacing:-.035em; }
    .lifki-payment-intro { margin:0 0 22px; color:#66756b; font-size:13px; line-height:1.55; }
    .lifki-payment-section { margin-top:18px; }
    .lifki-payment-label { display:block; margin:0 0 8px; color:#294a39; font-size:12px; font-weight:800; }
    .lifki-payment-field { min-height:48px; padding:6px 0; border:1px solid #d8e1d9; border-radius:12px; background:#fff; overflow:hidden; }
    .lifki-payment-field:focus-within { border-color:#7bb04c; box-shadow:0 0 0 4px rgba(183,238,116,.2); }
    .lifki-payment-field > div { min-height:40px; }
    .lifki-payment-submit { width:100%; min-height:52px; margin-top:22px; border:0; border-radius:12px; color:#173f2c; background:#bff275; box-shadow:0 8px 22px rgba(139,190,67,.22); font:inherit; font-size:14px; font-weight:850; cursor:pointer; transition:transform .18s ease,filter .18s ease,opacity .18s ease; }
    .lifki-payment-submit:hover:not(:disabled) { filter:brightness(.97); transform:translateY(-1px); }
    .lifki-payment-submit:disabled { opacity:.52; cursor:not-allowed; box-shadow:none; }
    .lifki-payment-security { display:flex; align-items:center; justify-content:center; gap:7px; margin:15px 0 0; color:#7a897e; font-size:11px; }
    .lifki-payment-security strong { color:#486a55; }
    .lifki-payment-message { min-height:20px; margin:12px 0 0; color:#6c786f; font-size:12px; line-height:1.45; text-align:center; }
    .lifki-payment-message.error { color:#a4433c; }
    .lifki-payment-message.success { color:#2b7549; }
    .lifki-payment-close { color:#698070 !important; }
    @media (max-width:720px) { .lifki-payment-shell { display:block; } .lifki-payment-story { padding:28px 24px; } .lifki-payment-story h2 { font-size:30px; } .lifki-payment-benefits { margin-top:22px; } .lifki-payment-note { display:none; } .lifki-payment-form { padding:24px 18px 26px; } }
  </style><div class="auth-card lifki-payment-card" role="dialog" aria-modal="true" aria-labelledby="lifkiPaymentTitle"><div class="lifki-payment-shell"><aside class="lifki-payment-story"><div class="lifki-payment-kicker">Lifki workspace</div><h2>Turn homeowner conversations into confident quotes.</h2><p>Activate the tools you need to capture, price, and follow up on kitchen and bathroom remodeling leads.</p><ul class="lifki-payment-benefits"><li><span class="lifki-payment-check">✓</span><span>Build consistent kitchen and bathroom estimates</span></li><li><span class="lifki-payment-check">✓</span><span>Turn chat conversations into organized leads</span></li><li><span class="lifki-payment-check">✓</span><span>Install your finished quote bubble on your website</span></li></ul><p class="lifki-payment-note">Your payment is processed securely by Whop. Lifki never receives your card number.</p></aside><div class="lifki-payment-form"><div class="lifki-payment-top"><div class="mini-brand"><i></i> Lifki billing</div><button class="close-widget lifki-payment-close" type="button" data-close-whop-checkout aria-label="Close checkout">×</button></div><div class="lifki-payment-step">Step 1 of 1 · Secure activation</div><h3 id="lifkiPaymentTitle">Activate your workspace</h3><p class="lifki-payment-intro">Enter your details below. Your account will become active after Whop confirms the payment.</p><div class="lifki-payment-section"><label class="lifki-payment-label">Email</label><div class="lifki-payment-field" id="lifkiPaymentEmail"></div></div><div class="lifki-payment-section"><label class="lifki-payment-label">Payment method</label><div class="lifki-payment-field" id="lifkiPaymentMethod"></div></div><div class="lifki-payment-section"><label class="lifki-payment-label">Billing address</label><div class="lifki-payment-field" id="lifkiPaymentAddress"></div></div><div class="lifki-payment-section" id="lifkiPaymentBranding"></div><button class="lifki-payment-submit" type="button" data-submit-whop-payment disabled>Activate workspace</button><p class="lifki-payment-security">🔒 <strong>Secure payment</strong> · Your card details stay with Whop</p><p class="lifki-payment-message" data-whop-payment-message>Choose a payment method to continue.</p></div></div></div>`;
  document.body.appendChild(modal);
  const close = () => closeLifkiPayment(modal);
  modal.querySelector("[data-close-whop-checkout]")?.addEventListener("click", close);
  const submit = modal.querySelector("[data-submit-whop-payment]");
  const message = modal.querySelector("[data-whop-payment-message]");
  const setMessage = (value, kind = "") => { if (message) { message.textContent = value; message.className = `lifki-payment-message${kind ? ` ${kind}` : ""}`; } };
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
    whopElementsInstance = window.WhopElements({
      environment: config.WHOP_CHECKOUT_EMBED_ENVIRONMENT || "production",
    });
    whopPaymentHandle = whopElementsInstance.payments.create({
      plan: planId,
      returnUrl: successUrl,
    });
    whopPaymentHandle.create("branding").mount("#lifkiPaymentBranding");
    whopPaymentHandle.create("email").mount("#lifkiPaymentEmail");
    whopPaymentHandle.create("address").mount("#lifkiPaymentAddress");
    whopPaymentHandle.create("payment", {
      onChange: (event) => {
        const complete = Boolean(event?.complete);
        if (submit) submit.disabled = !complete;
        if (complete) setMessage("Ready to activate securely.");
      },
      onAddressChange: (event) => {
        if (event?.complete && submit) submit.disabled = false;
      },
    }).mount("#lifkiPaymentMethod");
    setMessage("Loading secure payment methods…");

    submit?.addEventListener("click", async () => {
      if (!whopPaymentHandle || submit.disabled) return;
      submit.disabled = true;
      submit.textContent = "Securing your payment…";
      setMessage("Confirming your payment securely…");
      try {
        const token = await whopPaymentHandle.createConfirmationToken({
          billingDetails: { email: user?.email || "" },
        });
        const result = await supabase.functions.invoke(config.WHOP_PAYMENT_FUNCTION_NAME || "create-whop-payment", {
          body: { confirmation_token: token.confirmationToken, return_url: successUrl },
        });
        if (result.error) throw result.error;
        const response = result.data || {};
        if (response.error) throw new Error(response.error);
        let status = String(response.status || "").toLowerCase();
        if (response.client_secret && ["requires_action", "requires_confirmation", "pending", "processing"].includes(status)) {
          const nextAction = whopElementsInstance?.payments?.handleNextAction
            ? await whopElementsInstance.payments.handleNextAction({ clientSecret: response.client_secret, returnUrl: successUrl })
            : await whopPaymentHandle.handleNextAction({ clientSecret: response.client_secret, returnUrl: successUrl });
          status = String(nextAction?.status || status).toLowerCase();
        }
        if (["succeeded", "paid", "complete", "completed"].includes(status)) {
          try { sessionStorage.setItem("lifkiCheckoutReturn", "1"); } catch (error) {}
          setMessage("Payment received. Confirming your workspace…", "success");
          submit.textContent = "Workspace activation in progress…";
          if (user) {
            await loadSubscription(user);
            startSubscriptionPolling();
          }
          window.setTimeout(close, 1800);
          return;
        }
        if (["processing", "pending", "requires_action"].includes(status)) {
          setMessage("Your payment is processing. We will activate your workspace when Whop confirms it.", "success");
          submit.textContent = "Payment processing…";
          if (user) startSubscriptionPolling();
          return;
        }
        throw new Error("Whop has not confirmed the payment yet. Please try again.");
      } catch (error) {
        console.error("Custom Whop payment failed", error);
        submit.disabled = false;
        submit.textContent = "Activate workspace";
        setMessage(error?.message || "Payment could not be completed. Please try again.", "error");
      }
    });
  } catch (error) {
    console.error("Whop Payment Elements failed to load", error);
    setMessage("Secure payment fields could not load. Please try again.", "error");
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

async function saveWidgetDomain(button) {
  if (!user) return;
  const input = button.closest(".paid-integration-card")?.querySelector("[data-widget-domain]");
  const note = button.closest(".paid-integration-card")?.querySelector("[data-widget-domain-note]");
  const domain = normalizeWebsiteDomain(input?.value || "");
  if (!domain) {
    if (note) note.textContent = "Enter a valid website domain, such as yourwebsite.com.";
    input?.focus();
    return;
  }
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    const result = await supabase.from("subscriptions")
      .update({ website_domain: domain })
      .eq("user_id", user.id);
    if (result.error) throw result.error;
    subscription = { ...(subscription || {}), website_domain: domain };
    if (note) note.textContent = `Connected to ${domain}.`;
    button.textContent = "Saved";
  } catch (error) {
    console.error("Website domain save failed", error);
    if (note) note.textContent = "The website domain could not be saved. Please try again.";
    button.textContent = original;
  } finally {
    button.disabled = false;
    if (button.textContent === "Saved") window.setTimeout(() => { button.textContent = "Save website"; }, 1600);
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
  $("#appMain")?.querySelectorAll("[data-save-widget-domain]").forEach((button) => {
    button.onclick = () => { void saveWidgetDomain(button); };
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
      activation.insertAdjacentHTML("afterend", `<div class="paid-dashboard-gap" aria-hidden="true"></div><section class="app-card paid-integration-card"><div class="paid-code-head"><div><div class="paid-card-kicker">Installation</div><h3>Integration Code</h3></div><span class="paid-code-badge">Ready to install</span></div><p>Save the website domain once, then paste the same one-line script into that website. You will not need a different ID for each site.</p><div class="field"><label for="lifkiWebsiteDomain">Website domain</label><input id="lifkiWebsiteDomain" type="text" data-widget-domain value="${escapeHtml(record.website_domain || "")}" placeholder="https://yourwebsite.com" autocomplete="url"></div><div class="app-page-actions"><button class="app-primary-btn" type="button" data-save-widget-domain>Save website</button><span class="owner-save-note" data-widget-domain-note>${record.website_domain ? "Website connected to this workspace." : "Add the client website before installing the Widget."}</span></div><div class="field"><textarea readonly rows="5" aria-label="Integration Code">${escapeHtml(codeFor())}</textarea></div><div class="app-page-actions"><button class="app-primary-btn" type="button" data-copy-code="${escapeHtml(codeFor())}">Copy Code</button></div></section><div class="paid-dashboard-after-install-gap" aria-hidden="true"></div>`);
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
    .select("id,user_id,whop_membership_id,website_domain,subscription_status,current_period_end,updated_at")
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
