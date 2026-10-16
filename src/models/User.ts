import { Schema, model, models, type Model, type Types } from "mongoose";
import { ROLES, type Role } from "@/lib/roles";

export interface IUser {
  _id: Types.ObjectId;
  email: string;
  passwordHash: string;
  role: Role;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, required: true, default: "passenger" },
    name: { type: String, required: true, trim: true },
  },
  { timestamps: true },
);

export const User = (models.User as Model<IUser>) || model<IUser>("User", userSchema);
