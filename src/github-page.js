// Adds "Copy link" and "Copy stack" buttons to GitHub PR pages: in the header, and next
// to the merge button. A PR that Linear has linked also gets a "View in Linear" tab, and O
// then L opens it. The diff page gets a "Mark tests viewed" button by its viewed files
// count, and can start with test files collapsed.

const LINEAR_ICON =
  '<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z"></path></svg>';

// The React PR header first, then the classic one.
const TITLE_SELECTOR = 'h1[data-component="PH_Title"], .gh-header-title';
const FILES_TAB_SELECTOR = '#prs-files-anchor-tab, .tabnav-tabs a[href$="/files"]';

// Each loaded PR's Linear review URL, or null when Linear hasn't linked it or the tab is off.
const linearUrls = new Map();

const currentPrUrl = () => {
  const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(location.pathname);
  return match && `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`;
};

// Borrows the Files changed tab's classes, since GitHub's hashed class names change between builds.
const tabClasses = (element) =>
  [...element.classList].filter((name) => !name.startsWith("selected")).join(" ");

// Puts `node` in an empty copy of `model`, or returns it as is when there's no model.
const wrapLike = (node, model) => {
  if (!model) return node;
  const wrapper = model.cloneNode(false);
  wrapper.append(node);
  return wrapper;
};

/** A "View in Linear" tab shaped like Files changed, in a list item of its own when `filesItem` is one. */
const createLinearTab = (filesTab, filesItem, linearUrl) => {
  const link = document.createElement("a");
  link.className = tabClasses(filesTab);
  link.href = linearUrl;
  link.innerHTML = LINEAR_ICON;
  const icon = link.firstElementChild;
  const filesIcon = filesTab.querySelector("svg");
  if (filesIcon) icon.setAttribute("class", tabClasses(filesIcon));
  // The overview page wraps a tab's icon and label in spans that space them.
  const iconModel = filesIcon && filesIcon.parentElement !== filesTab ? filesIcon.parentElement : null;
  const labelModel = filesTab.querySelector('[data-component="text"]');
  const label = wrapLike(document.createTextNode("View in Linear"), labelModel);
  if (labelModel) label.dataset.content = "View in Linear";
  link.replaceChildren(wrapLike(icon, iconModel), label);
  if (filesItem === filesTab) {
    link.classList.add("stackslop-linear-tab");
    return link;
  }
  const item = document.createElement("li");
  item.className = `${filesItem.className} stackslop-linear-tab`;
  item.append(link);
  return item;
};

/** Keeps a "View in Linear" tab at the end of the PR tabs while the PR has a Linear review. */
const syncLinearTab = () => {
  const existing = document.querySelector(".stackslop-linear-tab");
  const linearUrl = linearUrls.get(currentPrUrl());
  const filesTab = linearUrl && document.querySelector(FILES_TAB_SELECTOR);
  if (!filesTab) return existing?.remove();
  // While the overview page's More menu is open, Files changed shows in it, so leave the tab be.
  if (filesTab.closest('[role="menu"]')) return;

  // The overview page wraps each tab in a list item, and moves every tab into its More menu
  // when an item holds a second link.
  const filesItem = filesTab.parentElement.matches("li") ? filesTab.parentElement : filesTab;
  const tab = createLinearTab(filesTab, filesItem, linearUrl);
  if (existing?.isEqualNode(tab) && filesItem.parentElement.lastElementChild === existing) return;

  existing?.remove();
  filesItem.parentElement.append(tab);
};

const isDiffPage = () => /^\/[^/]+\/[^/]+\/pull\/\d+\/(changes|files)/.test(location.pathname);

const markTestsViewed = async (button) => {
  button.disabled = true;
  const result = await Promise.resolve()
    .then(() => chrome.runtime.sendMessage({ type: "mark-tests-viewed", url: button.dataset.url }))
    .catch((error) => ({
      ok: false,
      message: chrome.runtime?.id ? error.message : "Stackslop was updated, so reload the page",
    }));
  button.disabled = false;
  if (result.needsToken) return chrome.runtime.sendMessage({ type: "open-options" });
  if (!result.ok) return toast("failed", `Couldn't mark tests viewed: ${result.message}`);
  if (result.marked === 0) return toast("copied", "No unviewed test files");
  location.reload();
};

const createMarkTestsButton = (url) => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "stackslop-button stackslop-mark-tests";
  button.dataset.url = url;
  button.innerHTML = `${CHECK_ICON}<span>Mark tests viewed</span>`;
  button.addEventListener("click", () => markTestsViewed(button));
  return button;
};

const DIFF_TOOLBAR_END = '[data-testid="diff-content"] > section > :last-child';

const syncMarkTestsButton = () => {
  const url = isDiffPage() && currentPrUrl();
  const existing = document.querySelector(".stackslop-mark-tests");
  const toolbarEnd = url && document.querySelector(DIFF_TOOLBAR_END);
  if (!toolbarEnd) return existing?.remove();

  const current = existing?.dataset.url === url;
  if (current && toolbarEnd.firstElementChild === existing) return;
  if (!current) existing?.remove();
  toolbarEnd.prepend(current ? existing : createMarkTestsButton(url));
};

const COLLAPSE_RETRY_MS = 500;
const MAX_COLLAPSE_CLICKS = 10;
const handledDiffs = new Set();
const collapseClicks = new Map();
let collapseRetry = null;
let collapsesTests = false;
let collapsePage = null;

const filePathOf = (diff) => diff.querySelector("h3 code")?.textContent.replace(/\u200e/g, "").trim();

const tooltipOf = (button) => document.getElementById(button?.getAttribute("aria-labelledby"))?.textContent.trim();

const collapseTestFiles = () => {
  const page = collapsesTests && isDiffPage() ? location.pathname : null;
  if (page !== collapsePage) {
    collapsePage = page;
    handledDiffs.clear();
    collapseClicks.clear();
  }
  if (!page) return;
  let waiting = false;
  for (const diff of document.querySelectorAll('[data-testid="progressive-diffs-list"] [role="region"][id^="diff-"]')) {
    if (handledDiffs.has(diff.id)) continue;
    const path = filePathOf(diff);
    const toggle = diff.querySelector("[data-diff-header-wrapper] button[aria-labelledby]");
    const tooltip = tooltipOf(toggle);
    if (!path || !tooltip) continue;

    const clicks = collapseClicks.get(diff.id) ?? { count: 0, at: 0 };
    if (!isTestFile(path) || tooltip !== "Collapse file" || clicks.count >= MAX_COLLAPSE_CLICKS) {
      handledDiffs.add(diff.id);
      collapseClicks.delete(diff.id);
      continue;
    }
    waiting = true;
    if (Date.now() - clicks.at < COLLAPSE_RETRY_MS) continue;
    collapseClicks.set(diff.id, { count: clicks.count + 1, at: Date.now() });
    toggle.click();
  }
  if (!waiting || collapseRetry) return;
  collapseRetry = setTimeout(() => {
    collapseRetry = null;
    collapseTestFiles();
  }, COLLAPSE_RETRY_MS);
};

chrome.storage.local.get("collapseTests").then(({ collapseTests }) => {
  collapsesTests = collapseTests === "collapse";
  collapseTestFiles();
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.collapseTests) collapsesTests = changes.collapseTests.newValue === "collapse";
});

linksListeners.add((url, result) => {
  if (!result.ok || linearUrls.get(url) === result.linearTabUrl) return;
  linearUrls.set(url, result.linearTabUrl);
  syncLinearTab();
});

start({
  currentPrUrl,
  onSync: () => {
    syncLinearTab();
    syncMarkTestsButton();
    collapseTestFiles();
  },
  opens: { l: { name: "Linear review", pick: (result) => result.linearUrl } },
  spots: {
    header: () => {
      // Signed in, GitHub's own header buttons sit here; sit with them at their size.
      const actions = document.querySelector('[data-component="PH_Actions"]');
      const hasGitHubButtons = [...(actions?.children ?? [])].some((child) => !child.matches(".stackslop-actions"));
      if (actions && !actions.classList.contains("d-none") && hasGitHubButtons) {
        return { parent: actions, first: true, size: "medium" };
      }
      const title = document.querySelector(TITLE_SELECTOR);
      if (!title) return null;
      // The React header keeps the "#123" next to the title, so go after it.
      const titleArea = title.closest('[data-component="TitleArea"]');
      if (titleArea) return { parent: titleArea, size: "small" };
      return { parent: title.parentElement, after: title, size: "small" };
    },
    "merge-box": () => {
      // The test id is stable; GitHub's hashed CSS module class names change between builds.
      const mergeButtons = document.querySelector(
        '[data-testid="mergebox-border-container"] [data-component="ButtonGroup"]',
      );
      return mergeButtons && { parent: mergeButtons.parentElement, after: mergeButtons, size: "medium" };
    },
  },
});
