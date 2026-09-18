/**
 * Test-only non-canonical WiFi fixture for regression tests.
 * NEVER import into agent reply paths — production Pine/West End WiFi is only
 * Pineland / lobsterbake (check-in templates).
 */
export const NON_CANONICAL_WIFI_FIXTURE = Object.freeze({
  ssid: 'WRONG_SSID',
  password: 'wrong-password',
});

/** @deprecated alias */
export const FORBIDDEN_PINE_WIFI = NON_CANONICAL_WIFI_FIXTURE;

/** Bad draft used in regression tests (must never ship to guests). */
export function badNonCanonicalWifiDump(guestFirstName = 'Guest') {
  return (
    `You're welcome, ${guestFirstName}! The WiFi network is ${NON_CANONICAL_WIFI_FIXTURE.ssid} ` +
    `and the password is ${NON_CANONICAL_WIFI_FIXTURE.password} (all lowercase). Let me know if it works.`
  );
}
