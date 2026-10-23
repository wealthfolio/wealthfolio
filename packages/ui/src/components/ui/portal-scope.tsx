"use client";

import * as React from "react";

const PortalScopeContext = React.createContext<string | undefined>(undefined);

interface PortalScopeProps {
  /** Marks the portal of every popup opened inside, as `data-portal-scope`. */
  name: string;
  children: React.ReactNode;
}

/**
 * Names the part of the app that popups opened inside it belong to. Popups
 * (dialogs, sheets, menus, tooltips…) render at the end of the document, away
 * from where they were opened, so the app finds them by this name, for example
 * to hide the popups of a screen it keeps mounted but out of sight.
 */
function PortalScope({ name, children }: PortalScopeProps) {
  return <PortalScopeContext.Provider value={name}>{children}</PortalScopeContext.Provider>;
}

/** Props for a popup's portal: the name of the scope it was opened in, if any. */
function usePortalScopeProps(): { "data-portal-scope"?: string } {
  const scope = React.useContext(PortalScopeContext);
  return scope === undefined ? {} : { "data-portal-scope": scope };
}

export { PortalScope, usePortalScopeProps };
