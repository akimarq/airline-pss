// Test env: never touch real services or the dev .env.local.
process.env.JWT_SECRET = "test-secret-test-secret-test-secret-123";
process.env.JWT_EXPIRES_IN = "1h";
process.env.AIRLINE_CODE = "PS";
process.env.AIRLINE_TICKET_PREFIX = "123";
