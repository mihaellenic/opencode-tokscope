import { formatHm } from "../format"
import type { PageView } from "./state"

const NOT_SAVED_SUFFIX = " · Cache not saved"
const SHARED_CACHE_SUFFIX = " · cache: shared"

function withPersistence(message: string, view: PageView): string {
  return view.persistence === "unavailable" ? message + NOT_SAVED_SUFFIX : message
}

function hasData(view: PageView): boolean {
  return view.samples.length > 0 || view.unavailable.length > 0
}

/** Progressive acquisition: the shared cache is being filled, so the results are incomplete. */
export function partialMessage(view: PageView): string {
  return withPersistence("History loading — results incomplete", view)
}

/** A stored window revalidating in the background, with the time of its last completed check. */
export function cachedMessage(view: PageView): string {
  const base =
    view.lastCheckedAt === undefined
      ? "Cached · refreshing…"
      : `Cached · last checked ${formatHm(view.lastCheckedAt)} · refreshing…`
  return withPersistence(base, view)
}

/** The refresh failed, but the rows from the last good check are still on screen. */
export function refreshFailedMessage(view: PageView): string {
  return withPersistence("Refresh failed — showing cached results", view)
}

/** The single status line above the content, or undefined when there is nothing unsettled to say. */
export function bannerMessage(view: PageView): string | undefined {
  switch (view.kind) {
    case "partial":
      return partialMessage(view)
    case "cached":
      return cachedMessage(view)
    case "error":
      return hasData(view) ? refreshFailedMessage(view) : undefined
    default:
      return undefined
  }
}

/**
 * The footer's trailing cache status. A ready view reports when it was last checked and that the
 * namespace is shared across the connected servers; a cached view only names the shared cache while
 * it revalidates. Accepted mixing never needs a screen of its own.
 */
export function footerStatusSuffix(view: PageView): string {
  switch (view.kind) {
    case "ready":
      return view.lastCheckedAt === undefined
        ? SHARED_CACHE_SUFFIX
        : ` · checked ${formatHm(view.lastCheckedAt)}${SHARED_CACHE_SUFFIX}`
    case "cached":
      return SHARED_CACHE_SUFFIX
    default:
      return ""
  }
}
