import { createContext } from "react";
import { detectContainer } from "../util/ipc.js";
import { openExternalLink } from "../util/openExternalLink.js";
import { getPointer } from "../util/pointer.js";
import { DeepLink, HostContextValue } from "../util/types.js";

/** What HostContext holds without a provider (see hasHostProvider). */
const noHostContext = defaultHostContext();

export const HostContext = createContext<HostContextValue>(noHostContext);
HostContext.displayName = "HostContext";

export function defaultHostContext(merge?: Partial<HostContextValue>): HostContextValue {
  const container = detectContainer();
  return {
    container,
    platform: "unknown",
    viewport: {},
    pointer: getPointer(),
    safeArea: {
      top: "0px",
      right: "0px",
      bottom: "0px",
      left: "0px",
    },
    preferredFontSize: 17, // From iOS defaults.
    deepLink: new DeepLink(),
    supportsEmailSignIn: false,
    supportsLogin: false,
    supportsNotifications: false,
    supportsContacts: false,
    supportsClipboardRead: container === "web" || container === "webapp",
    requiresNotificationAuthorization: false,
    supportsLightStatusBar: false,
    supportsPlaid: false,
    getPlugin: () => null,
    openUrl: async (url) => openExternalLink(url),
    sendSignInLink: async () => {},
    login: async () => {},
    requestNotificationAuthorization: async () => {},
    requestLocationWhenInUseAuthorization: async () => {},
    requestTemporaryFullAccuracyLocationAuthorization: async () => {},
    requestLocationUpdate: async () => {},
    openSettings: async () => {},
    requestReview: async () => {},
    badgeAppIcon: async () => {},
    clearReadNotifications: async () => {},
    scrollToTop: () => {},
    scrollToHome: () => false,
    copyToClipboard: (dataString: string) => {
      navigator.clipboard.writeText(dataString);
    },
    readFromClipboard: () => navigator.clipboard.readText(),
    showShareSheet: () => {},
    shareFile: async () => {},
    printUrl: async () => {},
    showMessageSheet: () => {},
    showEmailSheet: () => {},
    getContacts: async () => [],
    startSmsRetriever: async () => {},
    setWakeLock: async () => {},
    getBrightness: async () => 0,
    setBrightness: async () => {},
    setLightStatusBar: async () => {},
    openPlaid: async () => {},
    closePlaid: async () => {},
    delayUpdates: async () => {},
    unsafe_features: () => ({}),
    unsafe_send: async () => ({}),
    unsafe_post: () => {},
    ...merge,
  };
}

export const AndroidBackButtonClassName = "hardware-back";

/** Whether this context value came from a provider (real or mock). */
export function hasHostProvider(host: HostContextValue): boolean {
  return host !== noHostContext;
}
