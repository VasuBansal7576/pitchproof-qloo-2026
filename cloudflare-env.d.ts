declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    QLOO_API_KEY?: string;
    DEMO_UNLIMITED_DAILY_CAP?: string;
    MODEL_API_KEY?: string;
    OPENCODE_API_KEY?: string;
    MODEL_PROVIDER?: string;
    MODEL_NAME?: string;
  }
}
