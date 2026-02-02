export const env = {
  PORT: parseInt(process.env.PORT || "3000", 10),
  DATABASE_URL:
    process.env.DATABASE_URL || "mysql://root:buse.974@localhost:3306/qless",
  JWT_SECRET: process.env.JWT_SECRET || "dev-secret-change-in-production",
  VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY || "",
  VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY || "",
  VAPID_SUBJECT: process.env.VAPID_SUBJECT || "mailto:contact@byewait.fr",
};
