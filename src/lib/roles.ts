export const ROLES = ["passenger", "staff"] as const;
export type Role = (typeof ROLES)[number];
