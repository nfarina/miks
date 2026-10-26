import { HTMLAttributes } from "react";
import { styled } from "styled-components";
import { getSafeAreaCSS, SafeArea } from "../../safearea/safeArea.js";
import {
  badgeAppIcon,
  clearReadNotifications,
  closePlaid,
  delayUpdates,
  detectContainer,
  getBrightness,
  getContacts,
  login,
  openPlaid,
  openSettings,
  openUrl,
  post,
  printUrl,
  requestReview,
  requestLocationUpdate,
  requestLocationWhenInUseAuthorization,
  requestNotificationAuthorization,
  requestTemporaryFullAccuracyLocationAuthorization,
  send,
  sendSignInLink,
  setBrightness,
  setLightStatusBar,
  setWakeLock,
  shareFile as ipcShareFile,
  showEmailSheet,
  showMessageSheet,
  showShareSheet,
  startSmsRetriever,
} from "../util/ipc.js";
import {
  HostContainer,
  HostContextValue,
  HostFeatures,
  HostPlatform,
  HostPlugin,
} from "../util/types.js";
import { useBackButton } from "../util/useBackButton.js";
import { useClipboard } from "../util/useClipboard.js";
import { useDeepLinks } from "../util/useDeepLinks.js";
import { useFeatures } from "../util/useFeatures.js";
import { useHostLayout } from "../util/useHostLayout.js";
import { useHostViewport } from "../util/useHostViewport.js";
import { usePreferredFontSize } from "../util/usePreferredFontSize.js";
import { useSafeArea } from "../util/useSafeArea.js";
import { useScrollToTop } from "../util/useScrollToTop.js";
import { useWindowListener } from "../util/useWindowListener.js";
import { useMatchMedia } from "../../hooks/useMatchMedia.js";
import { getFoldStyle } from "../util/fold.js";
import { COARSE_POINTER_QUERY, getPointerStyle } from "../util/pointer.js";
import { getBarStripStyle, getSafeAreaCornersStyle, getTopBarStyle, reserveSafeArea } from "../util/barStrip.js";
import { BarEdgeContext } from "./BarEdgeContext.js";
import { HostContext } from "./HostContext.js";

export * from "./BarEdgeContext.js";
export * from "./HostContext.js";

export function HostProvider({
  container = detectContainer(),
  deviceId,
  ...rest
}: HTMLAttributes<HTMLDivElement> & {
  /** Allow setting the HostContainer directly for certain debugging situations. */
  container?: HostContainer;
  /** Allow setting the device ID directly for certain debugging situations. */
  deviceId?: string;
}) {
  const features = useFeatures();
  const viewport = useHostViewport();
  const layout = useHostLayout(features);
  const safeArea = useSafeArea(container, features, viewport);
  const deepLink = useDeepLinks(features);
  const clipboard = useClipboard(features);
  const preferredFontSize = usePreferredFontSize(features);

  // Initialize back button handling for Android.
  useBackButton();

  // Initialize scroll-to-top when tapping status bar on iOS.
  const { scrollToTop, scrollToHome } = useScrollToTop(container);

  // Whether we're pointed at with a finger. Published as --pointer too, for
  // coarsePointer().
  const coarse = useMatchMedia(COARSE_POINTER_QUERY);

  const value: HostContextValue | null =
    features && viewport && safeArea && deepLink
      ? {
          container,
          platform: (features.platform as HostPlatform) ?? "unknown",
          safeArea: reserveSafeArea(safeArea, layout),
          viewport,
          pointer: coarse ? "coarse" : "fine",
          layout,
          preferredFontSize,
          deepLink,
          deviceId: deviceId ?? features.identifier,
          clientUrl: features.clientUrl,
          webBundle: features.webBundle,
          supportsEmailSignIn: !!features.emailSignIn,
          supportsLogin: !!features.login,
          supportsNotifications: container === "android" || !!features.notifications, // All android devices support notifications without prompting.
          supportsShareSheet: !!features.shareSheet,
          supportsFileShare: !!features.fileShare,
          supportsPrint: !!features.print,
          supportsMessageSheet: !!features.messageSheet,
          supportsEmailSheet: !!features.emailSheet,
          supportsContacts: !!features.contacts,
          // Any plain web context can read the clipboard via navigator; host
          // containers must advertise the feature explicitly.
          supportsClipboardRead:
            container === "web" || container === "webapp" || !!features.clipboardRead,
          supportsWakeLock: !!features.wakeLock,
          supportsBrightness: !!features.brightness,
          supportsPlaid: !!features.plaid,
          supportsReviewPrompt: !!features.reviewPrompt,
          supportsLightStatusBar: container === "ios", // All iOS versions support this.
          requiresNotificationAuthorization: !!features.notificationAuthorization,
          smsAutoVerificationToken: features.smsAutoVerificationToken,
          getPlugin: (plugin: string) => buildPlugin(features, plugin),
          openUrl,
          sendSignInLink,
          login,
          requestNotificationAuthorization,
          requestLocationWhenInUseAuthorization,
          requestTemporaryFullAccuracyLocationAuthorization,
          requestLocationUpdate,
          openSettings,
          requestReview,
          badgeAppIcon,
          clearReadNotifications,
          scrollToTop,
          scrollToHome,
          copyToClipboard: clipboard.copy,
          readFromClipboard: clipboard.read,
          showShareSheet,
          shareFile: async ({ blob, fileName }) => {
            const data = await blobToBase64(blob);
            await ipcShareFile({ data, fileName, mimeType: blob.type });
          },
          printUrl,
          showMessageSheet,
          showEmailSheet,
          getContacts,
          startSmsRetriever,
          setWakeLock,
          getBrightness,
          setBrightness,
          setLightStatusBar,
          openPlaid,
          closePlaid,
          delayUpdates,
          unsafe_features: () => features,
          unsafe_send: send,
          unsafe_post: post,
        }
      : null;

  //
  // Render
  //

  if (!value) {
    return null; // Not loaded yet.
  }

  return (
    <HostContext value={value}>
      <BarEdgeContext value={layout?.barEdge ?? null}>
        {/* We need an actual HTML element in the DOM to attach our CSS custom properties to. */}
        <StyledHostProvider
          $safeArea={value.safeArea}
          {...rest}
          style={{
            ...getPointerStyle(value.pointer),
            ...getBarStripStyle(layout),
            ...getFoldStyle(layout),
            ...getSafeAreaCornersStyle(layout),
            ...getTopBarStyle(layout),
            ...rest.style,
          }}
        />
      </BarEdgeContext>
    </HostContext>
  );
}

export const StyledHostProvider = styled.div<{
  $safeArea: SafeArea;
}>`
  display: flex;
  flex-flow: column;
  ${({ $safeArea }) => getSafeAreaCSS($safeArea)}

  > * {
    flex-grow: 1;
  }
`;

/** Reads a Blob into a base64 string (without the data: URL prefix). */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function buildPlugin(features: HostFeatures, plugin: string): HostPlugin | null {
  const pluginFeatures = features.plugins?.[plugin];

  if (!pluginFeatures) {
    // Plugin not supported on this platform.
    return null;
  }

  return {
    ...pluginFeatures,
    send: (name, args) => send(name, { ...args, plugin }),
    post: (name, args) => post(name, { ...args, plugin }),
    useListener: (name, listener) => {
      useWindowListener(`${plugin}_${name}`, listener);
    },
  };
}
