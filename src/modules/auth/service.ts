import { hashPassword, signToken, verifyPassword } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import type { Role } from "@/lib/roles";
import { User, type IUser } from "@/models";

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export function toPublicUser(user: Pick<IUser, "_id" | "email" | "name" | "role">): PublicUser {
  return { id: user._id.toString(), email: user.email, name: user.name, role: user.role };
}

export async function createUser(input: {
  email: string;
  password: string;
  name: string;
  role: Role;
}): Promise<PublicUser> {
  if (await User.exists({ email: input.email })) {
    throw AppError.conflict("A user with this email already exists");
  }
  const user = await User.create({
    email: input.email,
    name: input.name,
    role: input.role,
    passwordHash: await hashPassword(input.password),
  });
  return toPublicUser(user);
}

export async function authenticate(email: string, password: string): Promise<{ token: string; user: PublicUser }> {
  const user = await User.findOne({ email }).select("+passwordHash");
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    throw AppError.unauthorized("Invalid email or password");
  }
  const publicUser = toPublicUser(user);
  const token = await signToken({ sub: publicUser.id, role: publicUser.role, email: publicUser.email });
  return { token, user: publicUser };
}
