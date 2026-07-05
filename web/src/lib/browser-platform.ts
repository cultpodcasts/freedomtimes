/** iPad/iPhone/iPod WebKit environments, including iPad desktop mode (MacIntel + touch). */
export function isIosWebKitBrowser(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }

  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    return true;
  }

  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

/** iPadOS, including desktop-mode iPad reporting MacIntel. */
export function isIpadOs(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }

  if (/iPad/i.test(navigator.userAgent)) {
    return true;
  }

  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

export function isStandalonePwa(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  if (window.matchMedia('(display-mode: standalone)').matches) {
    return true;
  }

  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}
