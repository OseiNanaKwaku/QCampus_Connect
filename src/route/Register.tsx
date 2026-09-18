import { useState, useRef } from 'react';
import { useAction, useMutation, useQuery } from 'convex/react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../convex/_generated/api';
import { saveSessionToken } from '../lib/session';
import { savePrivateKeyToIndexedDB } from '../utils/cryptoBridge';
import { toErrorText } from '../lib/convexErrors';
import ReCaptcha, { ReCaptchaRef } from '../components/ReCaptcha';
import '../route_css/Register.css';

const convexApi = api as any;

type RegisterErrorsRecord = {
  firstName?: string;
  lastName?: string;
  email?: string;
  institution?: string;
  department?: string;
  idNumber?: string;
  password?: string;
  confirmPassword?: string;
  recaptcha?: string;
  form?: string;
};

// const GHANA_INSTITUTIONS = [
//   'University of Energy and Natural Resources (UENR)',
//   'University of Ghana (UG)',
//   'Kwame Nkrumah University of Science and Technology (KNUST)',
//   'University of Cape Coast (UCC)',
//   'University for Development Studies (UDS)',
//   'Ghana Institute of Management and Public Administration (GIMPA)',
//   'Ashesi University',
//   'Central University',
//   'Wisconsin International University College',
//   'Valley View University',
//   'Ghana Communication Technology University (GCTU)',
//   'Accra Technical University',
//   'Kumasi Technical University',
//   'Ho Technical University',
//   'Sunyani Technical University',
//   'Takoradi Technical University',
//   'Cape Coast Technical University',
//   'Bolgatanga Technical University',
//   'Wa Technical University',
//   'University of Professional Studies, Accra (UPSA)',
//   'Ghana Institute of Journalism (GIJ)',
//   'SD Dombo University of Business and Integrated Development Studies',
// ];

const Register = () => {
  const navigate = useNavigate();
  const [role, setRole] = useState<'student' | 'lecturer'>('student');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [institution, setInstitution] = useState('University of Energy and Natural Resources (UENR)');
  const [department, setDepartment] = useState('');
  const [idNumber, setIdNumber] = useState('');
  const [rank, setRank] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [recaptchaToken, setRecaptchaToken] = useState('');
  const [errorsRecord, setErrorsRecord] = useState<RegisterErrorsRecord>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const institutionRef = useRef<HTMLDivElement>(null);
  const recaptchaRef = useRef<ReCaptchaRef>(null);

  const registerUser = useMutation(convexApi.qchat.registerUser);
  const registerUserWithRecaptcha = useAction(convexApi.qchat.registerUserWithRecaptcha);
  const departments = useQuery(convexApi.qchat.getDepartments);

  // Close dropdown when clicking outside (commented out as dropdown is disabled)
  // useEffect(() => {
  //   const handleClickOutside = (e: MouseEvent) => {
  //     if (institutionRef.current && !institutionRef.current.contains(e.target as Node)) {
  //       setShowInstitutionDropdown(false);
  //     }
  //   };
  //   document.addEventListener('mousedown', handleClickOutside);
  //   return () => document.removeEventListener('mousedown', handleClickOutside);
  // }, []);

  // const filteredInstitutions = GHANA_INSTITUTIONS.filter(inst =>
  //   inst.toLowerCase().includes(institution.toLowerCase())
  // );

  // Dynamic Label and Placeholder settings
  const idLabel = role === 'student' ? 'Student ID Number' : 'Staff ID Number';
  const idPlaceholder = role === 'student' ? 'UEB1234567' : 'PS100';

  // Real-time password strength calculation
  const getPasswordStrength = (pwd: string) => {
    if (!pwd) return { score: 0, text: 'No Password Entered', color: 'rgba(77, 70, 50, 0.4)' };
    let score = 0;
    if (pwd.length >= 8) score += 1;
    if (/[A-Z]/.test(pwd)) score += 1;
    if (/[a-z]/.test(pwd)) score += 1;
    if (/[0-9]/.test(pwd)) score += 1;
    if (/[^A-Za-z0-9]/.test(pwd)) score += 1;

    let text = 'Very Weak Security';
    let color = 'var(--error)'; // Ghana Red (#ba1a1a)
    if (score === 2) {
      text = 'Weak/Fair Security';
      color = '#e07a5f'; // Soft Orange
    } else if (score === 3) {
      text = 'Good Security';
      color = 'var(--primary)'; // Ghana Gold/Yellow (#FCD116)
    } else if (score === 4) {
      text = 'Strong Security';
      color = 'var(--secondary)'; // UENR Deep Blue (#3a5f94)
    } else if (score === 5) {
      text = 'Password is Strong';
      color = 'var(--tertiary)'; // Ghana Green (#046d3f)
    }
    return { score, text, color };
  };

  const strength = getPasswordStrength(password);

  const clearFieldError = (field: keyof RegisterErrorsRecord) => {
    setErrorsRecord((current) => {
      const next = { ...current };
      delete next[field];
      delete next.form;
      return next;
    });
  };

  /** Tier 1 — validate locally before calling Convex. */
  const runFrontendValidation = (): RegisterErrorsRecord | null => {
    const errors: RegisterErrorsRecord = {};
    const trimmedEmail = email.trim();
    const trimmedInstitution = institution.trim();
    const trimmedDepartment = department.trim();
    const trimmedIdNumber = idNumber.trim();

    if (!firstName.trim()) errors.firstName = "Enter your first name.";
    if (!lastName.trim()) errors.lastName = "Enter your last name.";

    if (!trimmedEmail) {
      errors.email = "Enter your institutional email address.";
    } else if (!trimmedEmail.includes("@")) {
      errors.email = "Enter a valid email address that includes @.";
    } else {
      const allowedDomains = ["@uenr.edu.gh", "@uner.edu.gh"];
      const hasAllowedDomain = allowedDomains.some((domain) =>
        trimmedEmail.toLowerCase().endsWith(domain)
      );
      if (!hasAllowedDomain) {
        errors.email = "Only @uenr.edu.gh email addresses are accepted for University of Energy and Natural Resources (UENR).";
      }
    }

    if (!trimmedInstitution) {
      errors.institution = "Enter your institution.";
    } else {
      const isUENR =
        trimmedInstitution.toLowerCase().includes("uenr") ||
        trimmedInstitution.toLowerCase().includes("uner") ||
        trimmedInstitution.toLowerCase().includes("university of energy and natural resources");
      if (!isUENR) {
        errors.institution = "Only University of Energy and Natural Resources (UENR) is accepted.";
      }
    }

    if (!trimmedDepartment) {
      errors.department = "Enter or select your department.";
    }

    if (!trimmedIdNumber) {
      errors.idNumber = `Enter your ${role === "student" ? "student ID number" : "staff ID number"}.`;
    } else if (role === "student") {
      if (!trimmedIdNumber.toUpperCase().startsWith("UEB")) {
        errors.idNumber = 'Student ID Number must start with "UEB" (e.g. UEB1234567).';
      }
    } else if (role === "lecturer") {
      const lecturerIdPattern = /^PS\d{3}$/;
      if (!lecturerIdPattern.test(trimmedIdNumber)) {
        errors.idNumber = 'Staff ID Number must start with uppercase "PS" followed by exactly 3 digits (e.g. PS100).';
      }
    }

    if (!password) errors.password = "Enter a password.";
    if (!confirmPassword) errors.confirmPassword = "Confirm your password.";

    if (password && confirmPassword && password !== confirmPassword) {
      errors.confirmPassword = "Passwords do not match.";
    }

    if (password && password.length < 8) {
      errors.password = "Password must be at least 8 characters long.";
    } else if (password && strength.score < 2) {
      errors.password = "Password is too weak. Please choose a stronger password.";
    }

    if (!recaptchaToken) {
      errors.recaptcha = "Please complete the reCAPTCHA verification.";
    }

    if (Object.keys(errors).length > 0) {
      return errors;
    }

    return null;
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
      // 1. Generate 2048-bit RSA-OAEP keypair using Web Crypto API
      const keyPair = await window.crypto.subtle.generateKey(
        {
          name: "RSA-OAEP",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["encrypt", "decrypt"]
      );

      // 2. Export Public Key as SPKI base64 string
      const exportedPublic = await window.crypto.subtle.exportKey("spki", keyPair.publicKey);
      const publicKeyBase64 = btoa(String.fromCharCode(...new Uint8Array(exportedPublic)));

      // 3. Register user with Convex action (verifying reCAPTCHA) or fallback to mutation
      let user;
      if (registerUserWithRecaptcha) {
        user = await registerUserWithRecaptcha({
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email,
          role,
          school: institution,
          department: department.trim(),
          rank: role === 'lecturer' ? rank.trim() || undefined : undefined,
          idNumber,
          password,
          publicKey: publicKeyBase64,
          hasKeypair: true,
          recaptchaToken,
        });
      } else {
        user = await registerUser({
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email,
          role,
          school: institution,
          department: department.trim(),
          rank: role === 'lecturer' ? rank.trim() || undefined : undefined,
          idNumber,
          password,
          publicKey: publicKeyBase64,
          hasKeypair: true,
        });
      }

      // 4. Save to local vault in IndexedDB indexed by user._id for persistent user-isolated storage
      await savePrivateKeyToIndexedDB(user._id, keyPair.privateKey);

      // 5. Asynchronously anchor user registration to Besu blockchain via Convex Action.
      //    This runs server-side (no CORS), so browser CORS restrictions don't apply.
      //    We log clearly to the console for easy identification of blockchain steps.
      console.log(`🔐 [Registration] ✅ User created in Convex DB`);
      console.log(`   👤 User ID:   ${user._id}`);
      console.log(`   📧 Email:     ${email}`);
      console.log(`   🏛️  Role:      ${role}`);
      console.log(`⛓️  [Blockchain] Background approval scheduled atomically on Hyperledger Besu.`);

      saveSessionToken(user.sessionToken);
      localStorage.setItem("qchat_active_user_id", user._id);
      navigate('/messages');
    } catch (err: any) {
      recaptchaRef.current?.reset();
      setRecaptchaToken('');

      // Use toErrorText to extract the clean, human-readable message from the Convex error
      const cleanedText = toErrorText(err);

      // Also build a raw fallback search string in case toErrorText returns empty
      const rawError = cleanedText ||
        `${err?.data || ''} ${err?.message || ''} ${typeof err?.toString === 'function' ? err.toString() : ''} ${JSON.stringify(err || '')}`.toLowerCase();

      // 🛡️ Default fallback
      let clearMessage = "Registration failed. Please try again.";

      // 🔎 Match against known backend ConvexError messages (case-insensitive)
      if (
        rawError.includes("an account with this email address already exists") ||
        rawError.includes("account already exists") ||
        rawError.includes("this account already exists") ||
        (rawError.includes("account") && rawError.includes("exist"))
      ) {
        clearMessage = "An account with this email address already exists.";
      } else if (
        rawError.includes("email address already exists") ||
        rawError.includes("email already exists")
      ) {
        clearMessage = "An account with this email address already exists.";
      } else if (rawError.includes("password already exists")) {
        clearMessage = "Password already exists.";
      } else if (
        rawError.includes("id number is already registered") ||
        rawError.includes("already registered with another account") ||
        rawError.includes("already registered")
      ) {
        clearMessage = "This ID number is already registered with another account.";
      } else if (rawError.includes("rank")) {
        clearMessage = "Select a valid academic rank.";
      } else if (rawError.includes("recaptcha") || rawError.includes("captcha")) {
        clearMessage = "reCAPTCHA verification failed. Please complete the check again.";
      } else if (rawError.includes("network") || rawError.includes("failed to fetch")) {
        clearMessage = "Unable to connect. Please check your internet connection.";
      } else if (cleanedText) {
        // Show the actual backend message directly if none of the above matched
        clearMessage = cleanedText.charAt(0).toUpperCase() + cleanedText.slice(1);
      }

      // 📝 Assign field-level and form-level errors
      const nextErrors: RegisterErrorsRecord = { form: clearMessage };
      if (clearMessage.toLowerCase().includes("email") || clearMessage.toLowerCase().includes("account already exists")) {
        nextErrors.email = clearMessage;
        document.getElementById("email")?.scrollIntoView({ behavior: "smooth", block: "center" });
      } else if (clearMessage.toLowerCase().includes("password already exists")) {
        nextErrors.password = clearMessage;
        document.getElementById("password")?.scrollIntoView({ behavior: "smooth", block: "center" });
      } else if (clearMessage.toLowerCase().includes("id number") || clearMessage.toLowerCase().includes("already registered")) {
        nextErrors.idNumber = clearMessage;
        document.getElementById("id_number")?.scrollIntoView({ behavior: "smooth", block: "center" });
      } else if (clearMessage.toLowerCase().includes("recaptcha") || clearMessage.toLowerCase().includes("captcha")) {
        nextErrors.recaptcha = clearMessage;
      }
      setErrorsRecord(nextErrors);

      console.error("Cleaned Error Output:", clearMessage);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="bg-shape one"></div>
      <div className="bg-shape two"></div>

      <main className="auth-main">
        <div className="auth-card register">
          <div className="auth-content">
            <div className="auth-title-container center">
              <div className="auth-title-icon">
                <span className="material-symbols-outlined" data-icon="school">
                  school
                </span>
              </div>
              <h1 className="auth-title">QCampus Connect</h1>
              <p className="auth-subtitle uppercase">
                Create Your Academic Identity
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
              </div>

              <div className="auth-row">
                <div className="auth-field-group">
                  <label className="auth-label" htmlFor="first_name">
                    First Name
                  </label>
                  <input
                    type="text"
                    id="first_name"
                    className={`auth-input ${errorsRecord.firstName ? "error" : ""}`}
                    placeholder="e.g. Kwame"
                    value={firstName}
                    onChange={(e) => {
                      setFirstName(e.target.value);
                      clearFieldError("firstName");
                    }}
                    aria-invalid={Boolean(errorsRecord.firstName)}
                    aria-describedby={
                      errorsRecord.firstName
                        ? "register-first-name-error"
                        : undefined
                    }
                  />
                  {errorsRecord.firstName && (
                    <p
                      className="auth-field-error"
                      id="register-first-name-error"
                    >
                      {errorsRecord.firstName}
                    </p>
                  )}
                </div>
                <div className="auth-field-group">
                  <label className="auth-label" htmlFor="last_name">
                    Last Name
                  </label>
                  <input
                    type="text"
                    id="last_name"
                    className={`auth-input ${errorsRecord.lastName ? "error" : ""}`}
                    placeholder="e.g. Mensah"
                    value={lastName}
                    onChange={(e) => {
                      setLastName(e.target.value);
                      clearFieldError("lastName");
                    }}
                    aria-invalid={Boolean(errorsRecord.lastName)}
                    aria-describedby={
                      errorsRecord.lastName
                        ? "register-last-name-error"
                        : undefined
                    }
                  />
                  {errorsRecord.lastName && (
                    <p
                      className="auth-field-error"
                      id="register-last-name-error"
                    >
                      {errorsRecord.lastName}
                    </p>
                  )}
                </div>
              </div>

              <div className="auth-field-group">
                <label className="auth-label" htmlFor="email">
                  Institutional Email
                </label>
                <input
                  type="email"
                  id="email"
                  className={`auth-input ${errorsRecord.email ? "error" : ""}`}
                  placeholder="username@uenr.edu.gh"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    clearFieldError("email");
                  }}
                  aria-invalid={Boolean(errorsRecord.email)}
                  aria-describedby={
                    errorsRecord.email ? "register-email-error" : undefined
                  }
                />
                <p className="auth-input-hint">
                  Please use your official @uenr.edu.gh
                </p>
                {errorsRecord.email && (
                  <p className="auth-field-error" id="register-email-error">
                    {errorsRecord.email}
                  </p>
                )}
              </div>

              <div className="auth-field-group" ref={institutionRef}>
                <label className="auth-label" htmlFor="institution">
                  Institution
                </label>
                <div className="institution-combobox-wrapper">
                  <div className="auth-input-wrapper">
                    <span
                      className="material-symbols-outlined auth-input-icon"
                      style={{ left: "0.875rem" }}
                    >
                      school
                    </span>
                    <input
                      type="text"
                      id="institution"
                      className={`auth-input ${errorsRecord.institution ? "error" : ""}`}
                      style={{
                        paddingLeft: "2.75rem",
                        paddingRight: "1rem",
                        borderRadius: "0.75rem",
                        border: "none",
                      }}
                      placeholder="University of Energy and Natural Resources (UENR)"
                      value={institution}
                      onChange={(e) => {
                        setInstitution(e.target.value);
                        clearFieldError("institution");
                      }}
                      autoComplete="off"
                      aria-invalid={Boolean(errorsRecord.institution)}
                      aria-describedby={
                        errorsRecord.institution
                          ? "register-institution-error"
                          : undefined
                      }
                    />
                    {/* Dropdown toggle icon commented out */}
                    {/* <span
                      className="material-symbols-outlined auth-select-icon"
                      style={{ cursor: 'pointer' }}
                      onClick={() => setShowInstitutionDropdown(v => !v)}
                    >
                      {showInstitutionDropdown ? 'expand_less' : 'expand_more'}
                    </span> */}
                  </div>

                  {/* Institution dropdown commented out — focusing on UENR only */}
                  {/* {showInstitutionDropdown && (
                    <div className="institution-dropdown">
                      {filteredInstitutions.length > 0 ? (
                        filteredInstitutions.map((inst) => (
                          <button
                            key={inst}
                            type="button"
                            className={`institution-option ${institution === inst ? 'selected' : ''}`}
                            onClick={() => {
                              setInstitution(inst);
                              clearFieldError('institution');
                              setShowInstitutionDropdown(false);
                            }}
                          >
                            <span className="material-symbols-outlined">account_balance</span>
                            {inst}
                          </button>
                        ))
                      ) : (
                        <div className="institution-no-match">
                          <span className="material-symbols-outlined">add_circle</span>
                          <span>Using <strong>&ldquo;{institution}&rdquo;</strong> as your institution</span>
                        </div>
                      )}
                    </div>
                  )} */}
                </div>
                {errorsRecord.institution && (
                  <p
                    className="auth-field-error"
                    id="register-institution-error"
                  >
                    {errorsRecord.institution}
                  </p>
                )}
              </div>

              <div className="auth-field-group">
                <label className="auth-label" htmlFor="department">
                  Department
                </label>
                <input
                  type="text"
                  id="department"
                  list="register-department-options"
                  className={`auth-input ${errorsRecord.department ? "error" : ""}`}
                  placeholder="Computer Science and Informatics"
                  value={department}
                  onChange={(e) => {
                    setDepartment(e.target.value);
                    clearFieldError("department");
                  }}
                  autoComplete="off"
                  aria-invalid={Boolean(errorsRecord.department)}
                  aria-describedby={
                    errorsRecord.department ? "register-department-error" : undefined
                  }
                />
                <datalist id="register-department-options">
                  {(departments ?? []).map((item: { _id: string; name: string }) => (
                    <option key={item._id} value={item.name} />
                  ))}
                </datalist>
                
                {errorsRecord.department && (
                  <p className="auth-field-error" id="register-department-error">
                    {errorsRecord.department}
                  </p>
                )}
              </div>

              <div className="auth-field-group">
                <label className="auth-label" htmlFor="id_number">
                  {idLabel}
                </label>
                <input
                  type="text"
                  id="id_number"
                  className={`auth-input ${errorsRecord.idNumber ? "error" : ""}`}
                  placeholder={idPlaceholder}
                  value={idNumber}
                  onChange={(e) => {
                    setIdNumber(e.target.value);
                    clearFieldError("idNumber");
                  }}
                  aria-invalid={Boolean(errorsRecord.idNumber)}
                  aria-describedby={
                    errorsRecord.idNumber
                      ? "register-id-number-error"
                      : undefined
                  }
                />
                {errorsRecord.idNumber && (
                  <p className="auth-field-error" id="register-id-number-error">
                    {errorsRecord.idNumber}
                  </p>
                )}
              </div>

              {role === "lecturer" && (
                <div className="auth-field-group">
                  <label className="auth-label" htmlFor="rank">
                    Academic Rank (Optional)
                  </label>
                  <div className="auth-input-wrapper">
                    <span
                      className="material-symbols-outlined auth-input-icon"
                      style={{ left: "0.875rem" }}
                    >
                      workspace_premium
                    </span>
                    <select
                      id="rank"
                      className="auth-input"
                      style={{ paddingLeft: "2.75rem", appearance: "auto" }}
                      value={rank}
                      onChange={(e) => setRank(e.target.value)}
                    >
                      <option value="">Select Rank (Optional)</option>
                      <option value="Dr">Dr</option>
                      <option value="Prof">Prof</option>
                      <option value="Engineer">Engineer</option>
                    </select>
                  </div>
                </div>
              )}

              <div className="auth-row">
                <div className="auth-field-group">
                  <label className="auth-label" htmlFor="password">
                    Password
                  </label>
                  <div className="auth-input-wrapper">
                    <input
                      type={showPassword ? "text" : "password"}
                      id="password"
                      className={`auth-input ${errorsRecord.password ? "error" : ""}`}
                      style={{ paddingRight: "2.5rem" }}
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        clearFieldError("password");
                      }}
                      aria-invalid={Boolean(errorsRecord.password)}
                      aria-describedby={
                        errorsRecord.password
                          ? "register-password-error"
                          : undefined
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
                  <div className="password-strength">
                    {[1, 2, 3, 4].map((barIndex) => {
                      let isFilled = false;
                      if (strength.score >= 1 && barIndex === 1)
                        isFilled = true;
                      else if (strength.score >= 2 && barIndex <= 2)
                        isFilled = true;
                      else if (strength.score >= 3 && barIndex <= 3)
                        isFilled = true;
                      else if (strength.score >= 4 && barIndex <= 4)
                        isFilled = true;

                      return (
                        <div
                          key={barIndex}
                          className="strength-bar"
                          style={{
                            backgroundColor: isFilled
                              ? strength.color
                              : "var(--surface-container-highest)",
                            transition: "background-color 0.3s ease",
                          }}
                        />
                      );
                    })}
                  </div>
                  <p
                    className="strength-text"
                    style={{
                      color: strength.color,
                      transition: "color 0.3s ease",
                    }}
                  >
                    {strength.text}
                  </p>
                  {errorsRecord.password && (
                    <p
                      className="auth-field-error"
                      id="register-password-error"
                    >
                      {errorsRecord.password}
                    </p>
                  )}
                </div>
                <div className="auth-field-group">
                  <label className="auth-label" htmlFor="confirm_password">
                    Confirm
                  </label>
                  <div className="auth-input-wrapper">
                    <input
                      type={showConfirmPassword ? "text" : "password"}
                      id="confirm_password"
                      className={`auth-input ${errorsRecord.confirmPassword ? "error" : ""}`}
                      style={{ paddingRight: "2.5rem" }}
                      value={confirmPassword}
                      onChange={(e) => {
                        setConfirmPassword(e.target.value);
                        clearFieldError("confirmPassword");
                      }}
                      aria-invalid={Boolean(errorsRecord.confirmPassword)}
                      aria-describedby={
                        errorsRecord.confirmPassword
                          ? "register-confirm-password-error"
                          : undefined
                      }
                    />
                    <button
                      type="button"
                      aria-label={
                        showConfirmPassword
                          ? "Hide confirm password"
                          : "Show confirm password"
                      }
                      className="material-symbols-outlined"
                      onClick={() =>
                        setShowConfirmPassword(!showConfirmPassword)
                      }
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
                      {showConfirmPassword ? "visibility_off" : "visibility"}
                    </button>
                  </div>
                  {errorsRecord.confirmPassword && (
                    <p
                      className="auth-field-error"
                      id="register-confirm-password-error"
                    >
                      {errorsRecord.confirmPassword}
                    </p>
                  )}
                </div>
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
                className="auth-submit large mt-4"
                disabled={isSubmitting}
              >
                <span className="material-symbols-outlined">
                  {isSubmitting ? "hourglass_top" : "how_to_reg"}
                </span>
                {isSubmitting ? "Registering..." : "Register"}
              </button>
              {errorsRecord.form && (
                <p className="auth-field-error center">{errorsRecord.form}</p>
              )}
            </form>

            <div className="auth-footer-text">
              <p>
                Already have an account?
                <Link to="/login">Login here</Link>
              </p>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default Register;
