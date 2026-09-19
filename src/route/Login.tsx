import { useState, useRef } from 'react';
import { useAction, useMutation } from 'convex/react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../convex/_generated/api';
import { getConvexErrorCode, isNetworkError, toErrorText } from '../lib/convexErrors';
import { saveSessionToken } from '../lib/session';
import ReCaptcha, { ReCaptchaRef } from '../components/ReCaptcha';
import '../route_css/Login.css';

const convexApi = api as any;

type LoginErrorsRecord = {
  role?: string;
  email?: string;
  password?: string;
  recaptcha?: string;
  form?: string;
};

const Login = () => {
  const navigate = useNavigate();
  const [role, setRole] = useState<'student' | 'lecturer'>('student');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [recaptchaToken, setRecaptchaToken] = useState('');
  const [errorsRecord, setErrorsRecord] = useState<LoginErrorsRecord>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const recaptchaRef = useRef<ReCaptchaRef>(null);
  const loginUser = useMutation(convexApi.qchat.loginUser);
  const loginUserWithRecaptcha = useAction(convexApi.qchat.loginUserWithRecaptcha);

  const clearFieldError = (field: keyof LoginErrorsRecord) => {
    setErrorsRecord((current) => {
      const next = { ...current };
      delete next[field];
      delete next.form;
      return next;
    });
  };

  /** Tier 1 — validate locally before calling Convex. */
  const runFrontendValidation = (): LoginErrorsRecord | null => {
    const errors: LoginErrorsRecord = {};
    const trimmedEmail = email.trim();

    if (!trimmedEmail) {
      errors.email = 'Enter your institutional email address.';
    } else if (!trimmedEmail.includes('@')) {
      errors.email = 'Enter a valid email address that includes @.';
    }

    if (!password) {
      errors.password = 'Enter your password.';
    }

    if (!recaptchaToken) {
      errors.recaptcha = 'Please complete the reCAPTCHA verification.';
    }

    return Object.keys(errors).length > 0 ? errors : null;
  };

  /** Tier 2 — map database errors to the correct field using keyword checks. */
  const applyBackendError = (error: unknown) => {
    if (isNetworkError(error)) {
      setErrorsRecord({ form: 'Unable to connect. Please check your internet connection.' });
      return;
    }

    const errorCode = getConvexErrorCode(error);

    if (errorCode === 'EMAIL_NOT_FOUND') {
      setErrorsRecord({ email: 'This email address is not registered with us.' });
      return;
    }

    if (errorCode === 'WRONG_ROLE') {
      setErrorsRecord({
        role: 'This email is registered under a different account type. Select the correct Student or Lecturer option.',
      });
      return;
    }

    if (errorCode === 'INVALID_PASSWORD') {
      setErrorsRecord({ password: 'The password you entered is incorrect. Please try again.' });
      return;
    }

    const errorText = toErrorText(error);

    if (
      errorCode === 'RECAPTCHA_FAILED' ||
      errorCode === 'RECAPTCHA_REQUIRED' ||
      errorText.includes('recaptcha verification failed') ||
      errorText.includes('recaptcha challenge') ||
      errorText.includes('recaptcha token')
    ) {
      setErrorsRecord({ recaptcha: 'reCAPTCHA verification failed. Please complete the check again.' });
      return;
    }

    if (errorText.includes('registered as')) {
      setErrorsRecord({
        role: 'This email is registered under a different account type. Select the correct Student or Lecturer option.',
      });
      return;
    }

    if (errorText.includes('incorrect') || errorText.includes('credential') || errorText.includes('password')) {
      setErrorsRecord({ password: 'The password you entered is incorrect. Please try again.' });
      return;
    }

    if (errorText.includes('no account') || errorText.includes('not found') || errorText.includes('exist')) {
      setErrorsRecord({ email: 'This email address is not registered with us.' });
      return;
    }

    setErrorsRecord({ form: 'Something went wrong. Please try again.' });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorsRecord({});

    const frontendErrors = runFrontendValidation();
    if (frontendErrors) {
      setErrorsRecord(frontendErrors);
      return;
    }

    setIsSubmitting(true);
    try {
      let user;
      if (loginUserWithRecaptcha) {
        user = await loginUserWithRecaptcha({ email, password, role, recaptchaToken });
      } else {
        user = await loginUser({ email, password, role });
      }
      console.groupCollapsed(`🔑 [Login] Authentication successful`);
      console.log(`✅ Authentication completed`);
      console.log(`   👤 User ID: ${user._id}`);
      console.log(`   👤 Role: ${role}`);
      console.log(`ℹ️ Login is an authentication/session event; no blockchain transaction is created by this code.`);
      console.groupEnd();

      saveSessionToken(user.sessionToken);
      localStorage.setItem("qchat_active_user_id", user._id);
      navigate('/messages');
    } catch (error) {
      recaptchaRef.current?.reset();
      setRecaptchaToken('');
      applyBackendError(error);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="auth-page">
      <header className="auth-header">
        <Link to="/" className="auth-header-brand">
          <div className="auth-header-icon">
            <span
              className="material-symbols-outlined"
              style={{ fontVariationSettings: "'FILL' 1" }}
            >
              school
            </span>
          </div>
          <span className="auth-header-text">QCampus Connect</span>
        </Link>
      </header>

      <main className="auth-main">
        <div className="auth-card">
          <div className="auth-tabs">
            <button className="auth-tab active">Login</button>
            <Link to="/register" className="auth-tab">
              Register
            </Link>
          </div>

          <div className="auth-content">
            <div className="auth-title-container">
              <h1 className="auth-title">Welcome Back</h1>
              <p className="auth-subtitle">
                Access your verified academic profile and credentials securely.
              </p>
            </div>

            <form className="auth-form" onSubmit={handleSubmit} noValidate>
              <div className="auth-field-group">
                <label className="auth-label">Select Account Type</label>
                <div className="auth-role-toggle">
                  <button
                    type="button"
                    className={`role-btn ${role === "student" ? "active" : ""}`}
                    onClick={() => {
                      setRole("student");
                      setErrorsRecord({});
                    }}
                  >
                    Student
                  </button>
                  <button
                    type="button"
                    className={`role-btn ${role === "lecturer" ? "active" : ""}`}
                    onClick={() => {
                      setRole("lecturer");
                      setErrorsRecord({});
                    }}
                  >
                    Lecturer
                  </button>
                </div>
                {errorsRecord.role && (
                  <p className="auth-field-error">{errorsRecord.role}</p>
                )}
              </div>

              <div className="auth-field-group">
                <label className="auth-label" htmlFor="email">
                  Email Address
                </label>
                <div className="auth-input-wrapper">
                  <div className="auth-input-icon">
                    <span className="material-symbols-outlined text-[20px]">
                      mail
                    </span>
                  </div>
                  <input
                    type="email"
                    id="email"
                    className={`auth-input with-icon ${errorsRecord.email ? "error" : ""}`}
                    placeholder="kwame.mensah@uenr.edu.gh"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      clearFieldError("email");
                    }}
                    aria-invalid={Boolean(errorsRecord.email)}
                    aria-describedby={
                      errorsRecord.email ? "login-email-error" : undefined
                    }
                  />
                </div>
                {errorsRecord.email && (
                  <p className="auth-field-error" id="login-email-error">
                    {errorsRecord.email}
                  </p>
                )}
              </div>

              <div className="auth-field-group">
                <label className="auth-label" htmlFor="password">
                  Secure Password
                </label>
                <div className="auth-input-wrapper">
                  <div className="auth-input-icon">
                    <span className="material-symbols-outlined text-[20px]">
                      lock
                    </span>
                  </div>
                  <input
                    type={showPassword ? "text" : "password"}
                    id="password"
                    className={`auth-input with-icon ${errorsRecord.password ? "error" : ""}`}
                    placeholder="••••••••••••"
                    style={{ paddingRight: "2.5rem" }}
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      clearFieldError("password");
                    }}
                    aria-invalid={Boolean(errorsRecord.password)}
                    aria-describedby={
                      errorsRecord.password ? "login-password-error" : undefined
                    }
                  />
                  <button
                    type="button"
                    aria-label={
                      showPassword ? "Hide password" : "Show password"
                    }
                    className="material-symbols-outlined"
                    onClick={() => setShowPassword(!showPassword)}
                    style={{
                      position: "absolute",
                      right: "0.875rem",
                      color: "var(--on-surface-variant)",
                      cursor: "pointer",
                      userSelect: "none",
                      fontSize: "1.25rem",
                      background: "none",
                      border: "none",
                      padding: 0,
                      display: "inline-flex",
                      alignItems: "center",
                    }}
                  >
                    {showPassword ? "visibility_off" : "visibility"}
                  </button>
                </div>
                {errorsRecord.password && (
                  <p className="auth-field-error" id="login-password-error">
                    {errorsRecord.password}
                  </p>
                )}
              </div>

              <div className="auth-helpers">
                <label className="remember-me">
                  <input type="checkbox" />
                  <span>Remember Me</span>
                </label>
                <Link to="/forgot-password" className="forgot-password">
                  Forgot Password?
                </Link>
              </div>

              <ReCaptcha
                ref={recaptchaRef}
                onVerify={(token) => {
                  setRecaptchaToken(token);
                  clearFieldError("recaptcha");
                }}
                onExpired={() => {
                  setRecaptchaToken("");
                }}
                onError={() => {
                  setRecaptchaToken("");
                }}
              />
              {errorsRecord.recaptcha && (
                <p
                  className="auth-field-error center"
                  style={{ marginBottom: "0.75rem" }}
                >
                  {errorsRecord.recaptcha}
                </p>
              )}

              <button
                type="submit"
                className="auth-submit"
                disabled={isSubmitting}
              >
                {isSubmitting ? "Logging in..." : "Login to Portal"}
                <span className="material-symbols-outlined text-[18px]">
                  {isSubmitting ? "hourglass_top" : "arrow_forward"}
                </span>
              </button>
              {errorsRecord.form && (
                <p className="auth-field-error center">{errorsRecord.form}</p>
              )}
            </form>
          </div>

          <div className="auth-security-footer">
            <p>
              Secured by <span>QCampus Connect</span> • Institutional account
              verification
            </p>
          </div>
        </div>
      </main>
    </div>
  );
};

export default Login;
