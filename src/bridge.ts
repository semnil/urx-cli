// The revision of the interface between this CLI's JavaScript and its native
// addon. The addon reports the revision it was built for, and the CLI refuses
// device access when the two differ. Both change together whenever an export,
// a method or a record shape of the addon changes.
export const BRIDGE_API_EXPECTED = 4;
