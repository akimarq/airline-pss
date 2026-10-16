import { z } from "zod";

const email = z.string().trim().toLowerCase().pipe(z.email());
const password = z.string().min(8, "Password must be at least 8 characters").max(128);
const name = z.string().trim().min(1).max(100);

export const registerSchema = z.object({ email, password, name });
export const loginSchema = z.object({ email, password: z.string().min(1) });
export const createStaffSchema = registerSchema;

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
