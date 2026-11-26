// The revision of the interface between this CLI's JavaScript and its native
// addon. The addon reports the revision it was built for, and the CLI refuses
// device access when the two differ.
export const BRIDGE_API_EXPECTED = 1;
