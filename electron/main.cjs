const { app, BrowserWindow, shell } = require("electron");
const path = require("path");

/**
 * Where the renderer loads from.
 *
 * Set VITE_DEV_SERVER_URL to point at a running `npm run dev`; leave it
 * unset and the window loads the built files in dist/. Keying off an
 * explicit variable rather than `app.isPackaged` is what makes
 * `npm run desktop` (build, then launch unpackaged) actually work — it
 * used to build the app and then try to reach a dev server that wasn't
 * running, showing a blank window.
 */
const devServerUrl = process.env.VITE_DEV_SERVER_URL;

/** The renderer is a local app; it has no business navigating anywhere else. */
function hardenNavigation(win) {
  const isInternal = (url) => {
    if (devServerUrl && url.startsWith(devServerUrl)) return true;
    return url.startsWith("file://");
  };

  // Print receipts and vouchers open a blank popup and write into it
  // (see the print helpers in the Restaurant, Expenses and Reports
  // modules), so about:blank must stay allowed. Anything with a real URL
  // goes to the user's browser instead of an unrestricted Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url === "about:blank" || url === "") return { action: "allow" };
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (isInternal(url)) return;
    event.preventDefault();
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#f5f7fa",
    // Avoids the white flash before the renderer paints.
    show: false,
    title: "InnPilot",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  win.once("ready-to-show", () => win.show());
  hardenNavigation(win);

  if (devServerUrl) {
    win.loadURL(devServerUrl);
    win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

// One instance only: two copies of a POS writing to the same hotel is a
// support call waiting to happen.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(createWindow);
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
