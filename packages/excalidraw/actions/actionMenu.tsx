import { KEYS } from "@excalidraw/common";

import { CaptureUpdateAction } from "@excalidraw/element";

import { HelpIconThin, settingsIcon } from "../components/icons";

import { register } from "./register";

export const actionShortcuts = register({
  name: "toggleShortcuts",
  label: "welcomeScreen.defaults.helpHint",
  icon: HelpIconThin,
  viewMode: true,
  trackEvent: { category: "menu", action: "toggleHelpDialog" },
  perform: (_elements, appState, _, { focusContainer }) => {
    if (appState.openDialog?.name === "help") {
      focusContainer();
    }
    return {
      appState: {
        ...appState,
        openDialog:
          appState.openDialog?.name === "help"
            ? null
            : {
                name: "help",
              },
        openMenu: null,
        openPopup: null,
      },
      captureUpdate: CaptureUpdateAction.EVENTUALLY,
    };
  },
  keyTest: (event) => event.key === KEYS.QUESTION_MARK,
});

export const actionOpenSettings = register({
  name: "openSettings",
  label: "keybindings.menuItem",
  icon: settingsIcon,
  viewMode: true,
  trackEvent: { category: "menu", action: "openSettings" },
  perform: (_elements, appState) => ({
    appState: {
      ...appState,
      openDialog:
        appState.openDialog?.name === "settings"
          ? null
          : { name: "settings" as const },
      openMenu: null,
      openPopup: null,
    },
    captureUpdate: CaptureUpdateAction.EVENTUALLY,
  }),
});
