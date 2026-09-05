import "dotenv/config";

export function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return value;
}

export const igdbCreds = () => ({
  clientId: required("TWITCH_CLIENT_ID"),
  clientSecret: required("TWITCH_CLIENT_SECRET"),
});
