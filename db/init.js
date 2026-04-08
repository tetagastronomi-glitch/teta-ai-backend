const pool = require("../db");

async function initDb() {
  try {
    // restaurants
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.restaurants (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // ✅ owner_phone (for WhatsApp routing) — always present, safe migration
    // 1) Add column if missing
    await pool.query(`
      ALTER TABLE public.restaurants
      ADD COLUMN IF NOT EXISTS owner_phone TEXT;
    `);

    // 2) Set default first (so new rows get it)
    await pool.query(`
      ALTER TABLE public.restaurants
      ALTER COLUMN owner_phone SET DEFAULT '';
    `);

    // 3) Backfill any existing NULLs
    await pool.query(`
      UPDATE public.restaurants
      SET owner_phone = ''
      WHERE owner_phone IS NULL;
    `);

    // 4) Enforce NOT NULL (now safe)
    await pool.query(`
      ALTER TABLE public.restaurants
      ALTER COLUMN owner_phone SET NOT NULL;
    `);

    // plan
    await pool.query(`
      ALTER TABLE public.restaurants
      ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'FREE';
    `);

    // ✅ RESERVATION RULES (SaaS per-business)
    // max_auto_confirm_people
    await pool.query(`
      ALTER TABLE public.restaurants
      ADD COLUMN IF NOT EXISTS max_auto_confirm_people INT;
    `);
    await pool.query(`
      ALTER TABLE public.restaurants
      ALTER COLUMN max_auto_confirm_people SET DEFAULT 6;
    `);
    await pool.query(`
      UPDATE public.restaurants
      SET max_auto_confirm_people = 6
      WHERE max_auto_confirm_people IS NULL;
    `);
    await pool.query(`
      ALTER TABLE public.restaurants
      ALTER COLUMN max_auto_confirm_people SET NOT NULL;
    `);
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ck_restaurants_max_auto_confirm_people') THEN
          ALTER TABLE public.restaurants
          ADD CONSTRAINT ck_restaurants_max_auto_confirm_people CHECK (max_auto_confirm_people BETWEEN 1 AND 50);
        END IF;
      END $$;
    `);

    // same_day_cutoff_hhmi
    await pool.query(`
      ALTER TABLE public.restaurants
      ADD COLUMN IF NOT EXISTS same_day_cutoff_hhmi TEXT;
    `);
    await pool.query(`
      ALTER TABLE public.restaurants
      ALTER COLUMN same_day_cutoff_hhmi SET DEFAULT '11:00';
    `);
    await pool.query(`
      UPDATE public.restaurants
      SET same_day_cutoff_hhmi = '11:00'
      WHERE same_day_cutoff_hhmi IS NULL OR same_day_cutoff_hhmi = '';
    `);
    await pool.query(`
      ALTER TABLE public.restaurants
      ALTER COLUMN same_day_cutoff_hhmi SET NOT NULL;
    `);
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ck_restaurants_same_day_cutoff_hhmi') THEN
          ALTER TABLE public.restaurants
          ADD CONSTRAINT ck_restaurants_same_day_cutoff_hhmi CHECK (same_day_cutoff_hhmi ~ '^\\d{2}:\\d{2}$');
        END IF;
      END $$;
    `);

    // ✅ FEEDBACK SETTINGS (OWNER-CONTROLLED)
    await pool.query(`
      ALTER TABLE public.restaurants
      ADD COLUMN IF NOT EXISTS feedback_enabled BOOLEAN NOT NULL DEFAULT TRUE;
    `);

    await pool.query(`
      ALTER TABLE public.restaurants
      ADD COLUMN IF NOT EXISTS feedback_cooldown_days INT NOT NULL DEFAULT 10;
    `);

    await pool.query(`
      ALTER TABLE public.restaurants
      ADD COLUMN IF NOT EXISTS feedback_batch_limit INT NOT NULL DEFAULT 30;
    `);

    await pool.query(`
      ALTER TABLE public.restaurants
      ADD COLUMN IF NOT EXISTS feedback_exclude_frequent_over_visits INT NOT NULL DEFAULT 5;
    `);

    await pool.query(`
      ALTER TABLE public.restaurants
      ADD COLUMN IF NOT EXISTS feedback_template TEXT NOT NULL DEFAULT '';
    `);

    // ✅ is_active (per-business enable/disable)
    await pool.query(`ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;`);
    await pool.query(`UPDATE public.restaurants SET is_active = true WHERE is_active IS NULL;`);

    // ✅ plan as VARCHAR(20) default 'free' (lowercase, backward compat)
    await pool.query(`ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS plan VARCHAR(20) DEFAULT 'free';`);

    // ✅ BILLING: trial period + plan expiry (manual payments)
    await pool.query(`ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS trial_ends DATE DEFAULT (CURRENT_DATE + INTERVAL '14 days');`);
    await pool.query(`ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS plan_expires DATE;`);

    // ✅ OPENING HOURS (per-business)
    await pool.query(`ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS opening_hours_start TEXT NOT NULL DEFAULT '11:00';`);
    await pool.query(`ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS opening_hours_end TEXT NOT NULL DEFAULT '21:00';`);

    // ✅ RESTAURANT DETAILS (for settings page)
    await pool.query(`ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS phone TEXT DEFAULT '';`);
    await pool.query(`ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS address TEXT DEFAULT '';`);
    await pool.query(`ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS email TEXT DEFAULT '';`);
    await pool.query(`ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'Europe/Tirane';`);
    await pool.query(`ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'sq';`);
    await pool.query(`ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS ai_provider TEXT DEFAULT 'anthropic';`);
    await pool.query(`ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS ai_model TEXT DEFAULT 'claude-sonnet-4-20250514';`);

    // ✅ MAX CAPACITY per timeslot (per-business)
    await pool.query(`ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS max_capacity INT NOT NULL DEFAULT 50;`);
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ck_restaurants_max_capacity') THEN
          ALTER TABLE public.restaurants ADD CONSTRAINT ck_restaurants_max_capacity CHECK (max_capacity BETWEEN 1 AND 500);
        END IF;
      END $$;
    `);

    // api_keys
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.api_keys (
        id SERIAL PRIMARY KEY,
        restaurant_id INT NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
        key_hash TEXT NOT NULL,
        label TEXT DEFAULT '',
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at TIMESTAMPTZ
      );
    `);

    // owner_keys
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.owner_keys (
        id SERIAL PRIMARY KEY,
        restaurant_id INT NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
        key_hash TEXT NOT NULL,
        label TEXT DEFAULT '',
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at TIMESTAMPTZ
      );
    `);

    // unique constraints on key_hash
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='uq_api_keys_key_hash') THEN
          ALTER TABLE public.api_keys
          ADD CONSTRAINT uq_api_keys_key_hash UNIQUE (key_hash);
        END IF;
      END $$;
    `);

    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='uq_owner_keys_key_hash') THEN
          ALTER TABLE public.owner_keys
          ADD CONSTRAINT uq_owner_keys_key_hash UNIQUE (key_hash);
        END IF;
      END $$;
    `);

    // feedback
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.feedback (
        id SERIAL PRIMARY KEY,
        restaurant_id INT NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
        restaurant_name TEXT NOT NULL DEFAULT 'Te Ta Gastronomi',
        phone TEXT NOT NULL,

        location_rating INT NOT NULL CHECK (location_rating BETWEEN 1 AND 5),
        hospitality_rating INT NOT NULL CHECK (hospitality_rating BETWEEN 1 AND 5),
        food_rating INT NOT NULL CHECK (food_rating BETWEEN 1 AND 5),
        price_rating INT NOT NULL CHECK (price_rating BETWEEN 1 AND 5),

        comment TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `)
    // ==================== FEEDBACK MESSAGES (WHATSAPP / MAKE) ====================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.feedback_messages (
        id BIGSERIAL PRIMARY KEY,
        restaurant_id BIGINT NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,

        twilio_message_sid TEXT UNIQUE,
        feedback_request_id TEXT,

        from_phone TEXT NOT NULL,
        message_body TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),

        classification TEXT,
        score INT CHECK (score BETWEEN 1 AND 10),

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_feedback_messages_restaurant_created ON public.feedback_messages (restaurant_id, created_at DESC);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_feedback_messages_classification ON public.feedback_messages (restaurant_id, classification);`);
;

    // Optional: link feedback -> reservation (safe)
    await pool.query(`
      ALTER TABLE public.feedback
      ADD COLUMN IF NOT EXISTS reservation_id INTEGER;
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_feedback_reservation_id
      ON public.feedback (reservation_id);
    `);

    // reservations
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.reservations (
        id SERIAL PRIMARY KEY,
        restaurant_id INT REFERENCES public.restaurants(id) ON DELETE CASCADE,
        reservation_id TEXT,
        restaurant_name TEXT NOT NULL DEFAULT 'Te Ta Gastronomi',
        customer_name TEXT NOT NULL,
        phone TEXT NOT NULL,
        date DATE NOT NULL,
        time TEXT NOT NULL,
        people INT NOT NULL,
        channel TEXT,
        area TEXT,
        first_time TEXT,
        allergies TEXT DEFAULT '',
        special_requests TEXT DEFAULT '',
        raw JSON,
        status TEXT NOT NULL DEFAULT 'Confirmed',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Ensure columns exist (non-breaking)
    await pool.query(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS reservation_id TEXT;`);
    await pool.query(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS restaurant_id INT;`);
    await pool.query(
      `ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS restaurant_name TEXT NOT NULL DEFAULT 'Te Ta Gastronomi';`
    );
    await pool.query(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS channel TEXT;`);
    await pool.query(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS area TEXT;`);
    await pool.query(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS first_time TEXT;`);
    await pool.query(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS allergies TEXT DEFAULT '';`);
    await pool.query(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS special_requests TEXT DEFAULT '';`);
    await pool.query(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS raw JSON;`);
    await pool.query(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'Confirmed';`);

    // ✅ FIX #3: closed_at/closed_reason PAS CREATE TABLE
    await pool.query(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;`);
    await pool.query(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS closed_reason TEXT DEFAULT '';`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_res_rest_closed_at ON public.reservations (restaurant_id, closed_at);`);

    // ✅ feedback anti-spam flags (safe)
    await pool.query(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS feedback_requested_at TIMESTAMP;`);
    await pool.query(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS feedback_received_at TIMESTAMP;`);

    // ✅ reminder tracking
    await pool.query(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;`);

    // FK (safe)
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_reservations_restaurant') THEN
          ALTER TABLE public.reservations
          ADD CONSTRAINT fk_reservations_restaurant
          FOREIGN KEY (restaurant_id)
          REFERENCES public.restaurants(id)
          ON DELETE CASCADE;
        END IF;
      END $$;
    `);

    // ==================== CRM: CUSTOMERS + CONSENTS (LEGAL) ====================
    await pool.query(`
      CREATE OR REPLACE FUNCTION public.set_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.customers (
        id BIGSERIAL PRIMARY KEY,
        restaurant_id BIGINT NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,

        phone TEXT NOT NULL,
        full_name TEXT,
        email TEXT,

        notes TEXT,
        tags TEXT[] DEFAULT ARRAY[]::TEXT[],

        first_seen_at TIMESTAMPTZ,
        last_seen_at TIMESTAMPTZ,
        visits_count INTEGER NOT NULL DEFAULT 0,

        -- CONSENTS
        consent_marketing BOOLEAN NOT NULL DEFAULT FALSE,
        consent_sms BOOLEAN NOT NULL DEFAULT FALSE,
        consent_whatsapp BOOLEAN NOT NULL DEFAULT FALSE,
        consent_email BOOLEAN NOT NULL DEFAULT FALSE,
        consent_source TEXT,
        consent_updated_at TIMESTAMPTZ,

        -- ✅ feedback cooldown tracking (safe)
        feedback_last_sent_at TIMESTAMP,
        feedback_last_received_at TIMESTAMP,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT uq_customers_restaurant_phone UNIQUE (restaurant_id, phone)
      );
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_customers_restaurant_id ON public.customers(restaurant_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_customers_phone ON public.customers(phone);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_customers_last_seen ON public.customers(last_seen_at);`);

    await pool.query(`DROP TRIGGER IF EXISTS trg_customers_updated_at ON public.customers;`);
    await pool.query(`
      CREATE TRIGGER trg_customers_updated_at
      BEFORE UPDATE ON public.customers
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
    `);

    // Owner views
    await pool.query(`
      CREATE OR REPLACE VIEW public.owner_customers AS
      SELECT
        id, restaurant_id, phone, full_name,
        visits_count, first_seen_at, last_seen_at,
        consent_marketing, consent_sms, consent_whatsapp, consent_email,
        created_at, updated_at
      FROM public.customers;
    `);

    await pool.query(`
      CREATE OR REPLACE VIEW public.owner_reservations AS
      SELECT
        id, restaurant_id, reservation_id,
        restaurant_name, customer_name, phone,
        date, time, people, channel, area,
        first_time, allergies, special_requests,
        status, created_at
      FROM public.reservations;
    `);

    // ==================== EVENTS (CORE) ====================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.events (
        id SERIAL PRIMARY KEY,

        restaurant_id INTEGER NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
        customer_id INTEGER NULL,

        reservation_id TEXT NULL,

        event_type VARCHAR(50) NOT NULL DEFAULT 'restaurant_reservation',
        event_date DATE NOT NULL,
        event_time TIME NOT NULL,

        people INTEGER,
        status VARCHAR(20) NOT NULL DEFAULT 'Pending',

        source VARCHAR(50),
        area VARCHAR(50),

        allergies TEXT,
        special_requests TEXT,
        notes TEXT,

        created_by VARCHAR(20) DEFAULT 'AI',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_events_restaurant_date
      ON public.events (restaurant_id, event_date);
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_status ON public.events (status);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_reservation_id ON public.events (reservation_id);`);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_res_rest_status_date
      ON public.reservations (restaurant_id, status, date);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_res_rest_phone_date
      ON public.reservations (restaurant_id, phone, date);
    `);

    // ==================== OWNER ACTION TOKENS (CLICK LINKS) ====================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.owner_action_tokens (
        id SERIAL PRIMARY KEY,
        restaurant_id INT NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
        reservation_id INT NOT NULL REFERENCES public.reservations(id) ON DELETE CASCADE,
        token TEXT NOT NULL UNIQUE,
        action TEXT NOT NULL CHECK (action IN ('confirm','decline')),
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ
      );
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_owner_action_tokens_token ON public.owner_action_tokens(token);`);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_owner_action_tokens_reservation ON public.owner_action_tokens(reservation_id);`
    );

    // bot_active flag per restaurant
    await pool.query(`
      ALTER TABLE public.restaurants
      ADD COLUMN IF NOT EXISTS bot_active BOOLEAN NOT NULL DEFAULT TRUE;
    `);

    // ==================== MISSED MESSAGES ====================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.missed_messages (
        id SERIAL PRIMARY KEY,
        restaurant_id INT NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
        phone TEXT NOT NULL,
        message TEXT DEFAULT '',
        received_at TIMESTAMPTZ,
        handled_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // ==================== JERRY MEMORY ====================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS jerry_memory (
        id SERIAL PRIMARY KEY,
        type VARCHAR(50) NOT NULL,
        category VARCHAR(50),
        content TEXT NOT NULL,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS jerry_incidents (
        id SERIAL PRIMARY KEY,
        type VARCHAR(50) NOT NULL,
        severity INTEGER DEFAULT 1,
        description TEXT,
        cause TEXT,
        action_taken TEXT,
        resolved BOOLEAN DEFAULT false,
        resolved_at TIMESTAMP,
        duration_seconds INTEGER,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // ==================== MARKETING ====================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS marketing_campaigns (
        id SERIAL PRIMARY KEY,
        restaurant_id INTEGER REFERENCES restaurants(id),
        segment VARCHAR(20) NOT NULL,
        channel VARCHAR(20) NOT NULL,
        message TEXT NOT NULL,
        template_name VARCHAR(100),
        recipients_count INTEGER DEFAULT 0,
        sent_count INTEGER DEFAULT 0,
        failed_count INTEGER DEFAULT 0,
        status VARCHAR(20) DEFAULT 'completed',
        triggered_by VARCHAR(20) DEFAULT 'manual',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS customer_scores (
        id SERIAL PRIMARY KEY,
        restaurant_id INTEGER REFERENCES restaurants(id),
        phone VARCHAR(30) NOT NULL,
        recency_score INTEGER DEFAULT 0,
        frequency_score INTEGER DEFAULT 0,
        value_score INTEGER DEFAULT 0,
        rfv_total INTEGER DEFAULT 0,
        segment VARCHAR(20) DEFAULT 'cold',
        last_calculated TIMESTAMP DEFAULT NOW(),
        UNIQUE(restaurant_id, phone)
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS marketing_triggers (
        id SERIAL PRIMARY KEY,
        restaurant_id INTEGER REFERENCES restaurants(id),
        trigger_type VARCHAR(50) NOT NULL,
        segment VARCHAR(20),
        channel VARCHAR(20) DEFAULT 'whatsapp',
        message_template TEXT NOT NULL,
        is_active BOOLEAN DEFAULT true,
        last_run TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // ✅ PIN login for restaurant owners
    await pool.query(`ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS pin_code VARCHAR(10);`);

    // ✅ Support tickets (Jerry escalation)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.support_tickets (
        id SERIAL PRIMARY KEY,
        restaurant_id INTEGER REFERENCES public.restaurants(id),
        restaurant_name VARCHAR(255),
        customer_message TEXT,
        jerry_reply TEXT,
        status VARCHAR(20) DEFAULT 'open',
        admin_notes TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        resolved_at TIMESTAMP
      );
    `);

    console.log("✅ DB ready (migrations applied)");
  } catch (err) {
    console.error("❌ initDb error:", err);
  }
}

module.exports = { initDb };
