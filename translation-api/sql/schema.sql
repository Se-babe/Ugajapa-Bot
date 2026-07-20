-- UgaJapa Translation API schema
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(255) NOT NULL,
  plan VARCHAR(50) NOT NULL DEFAULT 'free',
  stripe_customer_id VARCHAR(255),
  stripe_subscription_id VARCHAR(255),
  stripe_subscription_status VARCHAR(50),
  stripe_current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  email_verified BOOLEAN NOT NULL DEFAULT TRUE,
  verification_code VARCHAR(10),
  verification_code_expires_at TIMESTAMPTZ,
  verification_code_sent_at TIMESTAMPTZ,
  CONSTRAINT users_plan_check CHECK (plan IN ('free', 'starter', 'business', 'enterprise'))
);

CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_hash VARCHAR(255) NOT NULL,
  key_prefix VARCHAR(32) NOT NULL,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS usage_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  characters INTEGER NOT NULL,
  from_lang VARCHAR(16) NOT NULL,
  to_lang VARCHAR(16) NOT NULL,
  engine VARCHAR(64) NOT NULL,
  quality_score DECIMAL(4,3),
  request_id VARCHAR(64) UNIQUE,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS translation_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id VARCHAR(64) NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  api_key_id UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (request_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_feedback_request ON translation_feedback(request_id);

CREATE INDEX IF NOT EXISTS idx_usage_user_month ON usage_records(user_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_usage_key ON usage_records(api_key_id);

CREATE TABLE IF NOT EXISTS billing (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month VARCHAR(7) NOT NULL,
  characters_total BIGINT NOT NULL DEFAULT 0,
  amount_usd DECIMAL(10,2) NOT NULL DEFAULT 0,
  paid BOOLEAN NOT NULL DEFAULT FALSE,
  stripe_session_id VARCHAR(255),
  stripe_payment_intent_id VARCHAR(255),
  paid_at TIMESTAMPTZ,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, month)
);

CREATE INDEX IF NOT EXISTS idx_billing_user ON billing(user_id);

CREATE TABLE IF NOT EXISTS revoked_tokens (
  jti VARCHAR(64) PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- No FK on user_id: it may reference either users or admins (two separate
-- tables), and a failed login (no such user) has no valid id to point to.
CREATE TABLE IF NOT EXISTS login_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  email VARCHAR(255) NOT NULL,
  success BOOLEAN NOT NULL,
  reason VARCHAR(64),
  ip_address VARCHAR(64),
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_login_events_user ON login_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_events_created ON login_events(created_at DESC);

-- Training data accumulated from every translation request.
-- nllb_output    = what the on-device NLLB-200 model produced
-- teacher_output = best result from Google/Groq (the "ground truth" for learning)
-- teacher_engine = which external engine produced the ground truth
-- used_teacher   = TRUE when the teacher result was served to the user (bot quality was lower)
CREATE TABLE IF NOT EXISTS translation_pairs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_lang      VARCHAR(16) NOT NULL,
  to_lang        VARCHAR(16) NOT NULL,
  source_text    TEXT        NOT NULL,
  nllb_output    TEXT,
  teacher_output TEXT        NOT NULL,
  teacher_engine VARCHAR(32) NOT NULL,
  quality_score  FLOAT,
  used_teacher   BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tp_langs   ON translation_pairs(from_lang, to_lang);
CREATE INDEX IF NOT EXISTS idx_tp_quality ON translation_pairs(quality_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_tp_created ON translation_pairs(created_at DESC);
