/**
 * Get Started — the three-step hotel setup wizard.
 *
 *   1. Hotel     — name, city, currency
 *   2. Business  — phone, email, number of rooms
 *   3. Workspace — review, then create
 *
 * Designed to take well under thirty seconds: two required fields on the
 * first step, sensible defaults for the rest, and Enter advances every
 * step. All validation and the actual write live in src/lib/onboarding.ts;
 * this file only presents them.
 */
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft,
  ArrowRight,
  BedDouble,
  Building2,
  Check,
  LayoutDashboard,
  Minus,
  Phone,
  Plus,
  Sparkles,
} from "lucide-react";

import innpilotMark from "../../assets/brand/innpilot-mark.png";
import innpilotMarkOnLight from "../../assets/brand/innpilot-mark-on-light.png";
import { FormError, useToast } from "../../components/ui";
import { CURRENCIES, useHotelProfile } from "../../lib/hotelProfile";
import { money, plural } from "../../lib/format";
import {
  EMPTY_SETUP,
  MAX_ROOMS,
  MIN_ROOMS,
  createWorkspace,
  planRooms,
  summarizeRooms,
  validateBusinessStep,
  validateHotelStep,
  type SetupErrors,
  type WorkspaceSetupInput,
} from "../../lib/onboarding";
import { useWorkspace } from "../../workspace/workspaceContext";

type Step = 0 | 1 | 2;

const STEPS = [
  { title: "Hotel", description: "Name, city and currency" },
  { title: "Business", description: "Contact and rooms" },
  { title: "Workspace", description: "Review and create" },
] as const;

const hasErrors = (errors: SetupErrors) => Object.values(errors).some(Boolean);

export default function SetupWizard() {
  const navigate = useNavigate();
  const toast = useToast();
  const { hotelId: existingHotelId, enterWorkspace } = useWorkspace();
  const { profile: existingProfile } = useHotelProfile(existingHotelId);

  const [step, setStep] = useState<Step>(0);
  const [form, setForm] = useState<WorkspaceSetupInput>(EMPTY_SETUP);
  const [errors, setErrors] = useState<SetupErrors>({});
  const [creating, setCreating] = useState(false);
  const [submitError, setSubmitError] = useState("");

  /** Only meaningful once step 2 has validated the room count. */
  const roomSummary = useMemo(
    () =>
      validateBusinessStep(form).roomCount
        ? []
        : summarizeRooms(planRooms(form.roomCount, form.currency)),
    [form]
  );

  const update = <K extends keyof WorkspaceSetupInput>(key: K, value: WorkspaceSetupInput[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => (current[key] ? { ...current, [key]: undefined } : current));
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (creating) return;

    if (step === 0) {
      const found = validateHotelStep(form);
      setErrors(found);
      if (!hasErrors(found)) setStep(1);
      return;
    }
    if (step === 1) {
      const found = validateBusinessStep(form);
      setErrors(found);
      if (!hasErrors(found)) setStep(2);
      return;
    }

    setCreating(true);
    setSubmitError("");
    const result = await createWorkspace(form);
    if (!result.ok) {
      setCreating(false);
      setSubmitError(result.error);
      return;
    }

    enterWorkspace(result.data.hotelId);
    toast.success(`Welcome to InnPilot, ${form.hotelName.trim()}`);
    navigate("/dashboard", { replace: true });
  };

  const goBack = () => {
    setErrors({});
    setSubmitError("");
    setStep((current) => (current > 0 ? ((current - 1) as Step) : current));
  };

  return (
    <div className="min-h-screen w-full flex" style={{ background: "var(--app-bg)" }}>
      <BrandPanel />

      <main className="flex-1 min-w-0 flex flex-col">
        <header className="flex items-center justify-between h-16 px-5 sm:px-8">
          <Link to="/staff" className="flex items-center gap-2 lg:invisible" aria-label="InnPilot home">
            <img src={innpilotMarkOnLight} alt="" className="w-7 h-7 object-contain" />
            <span className="font-semibold" style={{ color: "var(--text)" }}>
              InnPilot
            </span>
          </Link>
          <span className="text-sm muted">Step {step + 1} of 3</span>
        </header>

        <div className="flex-1 flex items-start sm:items-center justify-center px-4 sm:px-8 pb-10">
          <div className="w-full max-w-xl">
            <Stepper current={step} />

            {existingHotelId && (
              <div
                className="mt-6 rounded-xl px-4 py-3 text-sm flex flex-col sm:flex-row sm:items-center gap-3"
                style={{
                  background: "var(--info-soft)",
                  border: "1px solid var(--info-border)",
                  color: "var(--info-text)",
                }}
              >
                <p className="flex-1">
                  This browser is already linked to{" "}
                  <strong>{existingProfile.name || "a workspace"}</strong>. Creating a new workspace
                  will switch this browser to the new hotel.
                </p>
                <Link to="/dashboard" className="btn btn-secondary btn-sm shrink-0">
                  Open dashboard
                </Link>
              </div>
            )}

            <form
              onSubmit={handleSubmit}
              noValidate
              className="card mt-6 p-6 sm:p-10"
              style={{ borderRadius: "var(--r-xl)", boxShadow: "var(--shadow-lg)" }}
            >
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={step}
                  initial={{ opacity: 0, x: 16 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -16 }}
                  transition={{ duration: 0.18 }}
                >
                  {step === 0 && <HotelStep form={form} errors={errors} update={update} />}
                  {step === 1 && <BusinessStep form={form} errors={errors} update={update} />}
                  {step === 2 && (
                    <ReviewStep form={form} rooms={roomSummary} onEdit={(target) => setStep(target)} />
                  )}
                </motion.div>
              </AnimatePresence>

              {submitError && (
                <div className="mt-6">
                  <FormError message={submitError} />
                </div>
              )}

              <div className="mt-8 flex items-center justify-between gap-3">
                {step > 0 ? (
                  <button type="button" className="btn btn-ghost" onClick={goBack} disabled={creating}>
                    <ArrowLeft size={16} /> Back
                  </button>
                ) : (
                  <Link to="/staff" className="btn btn-ghost">
                    Cancel
                  </Link>
                )}

                <button type="submit" className="btn btn-primary px-6" disabled={creating}>
                  {step < 2 ? (
                    <>
                      Continue <ArrowRight size={16} />
                    </>
                  ) : creating ? (
                    <>
                      <span
                        className="w-4 h-4 rounded-full animate-spin"
                        style={{ border: "2px solid rgba(255,255,255,0.4)", borderTopColor: "#fff" }}
                        aria-hidden
                      />
                      Creating workspace…
                    </>
                  ) : (
                    <>
                      Create workspace <ArrowRight size={16} />
                    </>
                  )}
                </button>
              </div>
            </form>

            <p className="text-xs muted text-center mt-5">
              No account needed. Your workspace is remembered in this browser.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function BrandPanel() {
  const points = [
    { icon: <BedDouble size={18} />, text: "Rooms and starting rates, built for you" },
    { icon: <LayoutDashboard size={18} />, text: "A live dashboard for revenue and occupancy" },
    { icon: <Sparkles size={18} />, text: "No sign-up, no password, no installation" },
  ];

  return (
    <aside
      className="hidden lg:flex lg:w-[42%] xl:w-[38%] relative overflow-hidden flex-col justify-between p-12"
      style={{ background: "var(--rail)" }}
    >
      <div
        className="pointer-events-none absolute -top-32 -right-24 w-[420px] h-[420px] rounded-full blur-3xl"
        style={{ background: "radial-gradient(circle, rgba(45,212,200,0.22) 0%, transparent 70%)" }}
      />
      <div
        className="pointer-events-none absolute -bottom-40 -left-24 w-[420px] h-[420px] rounded-full blur-3xl"
        style={{ background: "radial-gradient(circle, rgba(14,147,163,0.18) 0%, transparent 70%)" }}
      />

      <Link to="/staff" className="relative flex items-center gap-2.5" aria-label="InnPilot home">
        <img src={innpilotMark} alt="" className="w-9 h-9 object-contain" />
        <span className="text-[17px] font-semibold text-white tracking-tight">InnPilot</span>
      </Link>

      <div className="relative">
        <h1 className="text-3xl xl:text-4xl font-bold text-white leading-tight mb-4">
          Your hotel, up and running in under a minute.
        </h1>
        <p className="text-base leading-relaxed mb-8" style={{ color: "var(--rail-text)" }}>
          Create a workspace and InnPilot sets up your rooms, nightly rates and dashboard, ready
          for your first booking.
        </p>
        <ul className="space-y-4">
          {points.map((point) => (
            <li key={point.text} className="flex items-center gap-3 text-sm" style={{ color: "var(--rail-text)" }}>
              <span
                className="w-9 h-9 rounded-lg flex items-center justify-center flex-none"
                style={{ background: "var(--rail-active)", color: "var(--brand-cyan)" }}
              >
                {point.icon}
              </span>
              {point.text}
            </li>
          ))}
        </ul>
      </div>

      <p className="relative text-xs" style={{ color: "var(--rail-text-muted)" }}>
        © {new Date().getFullYear()} InnPilot · Built by Masai Labs
      </p>
    </aside>
  );
}

function Stepper({ current }: { current: Step }) {
  return (
    <ol className="flex items-center gap-2 sm:gap-3" aria-label="Setup progress">
      {STEPS.map((step, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li
            key={step.title}
            className="flex items-center gap-2 sm:gap-3 flex-1 last:flex-none"
            aria-current={active ? "step" : undefined}
          >
            <span
              className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold flex-none transition-colors"
              style={
                done
                  ? { background: "var(--primary)", color: "var(--text-inverse)" }
                  : active
                    ? { border: "2px solid var(--primary)", color: "var(--primary)", background: "var(--surface)" }
                    : { border: "1.5px solid var(--border-strong)", color: "var(--text-muted)", background: "var(--surface)" }
              }
            >
              {done ? <Check size={16} /> : index + 1}
            </span>
            <span className="hidden sm:block min-w-0">
              <span
                className="block text-sm font-semibold leading-tight"
                style={{ color: done || active ? "var(--text)" : "var(--text-muted)" }}
              >
                {step.title}
              </span>
              <span className="block text-xs muted truncate">{step.description}</span>
            </span>
            {index < STEPS.length - 1 && (
              <span
                className="flex-1 h-px min-w-4"
                style={{ background: done ? "var(--primary)" : "var(--border-strong)" }}
                aria-hidden
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function StepHeading({ icon, title, subtitle }: { icon: ReactNode; title: string; subtitle: string }) {
  return (
    <div className="mb-7">
      <span
        className="w-11 h-11 rounded-xl flex items-center justify-center mb-4"
        style={{ background: "var(--primary-soft)", color: "var(--primary)" }}
      >
        {icon}
      </span>
      <h2 className="text-2xl font-bold tracking-tight" style={{ color: "var(--text)" }}>
        {title}
      </h2>
      <p className="text-sm muted mt-1">{subtitle}</p>
    </div>
  );
}

function SetupField({
  id,
  label,
  optional = false,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  optional?: boolean;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="field-label flex items-center justify-between gap-2">
        <span>{label}</span>
        {optional && <span className="text-xs font-normal muted">Optional</span>}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-xs mt-1.5" style={{ color: "var(--danger-text)" }} role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs muted mt-1.5">{hint}</p>
      ) : null}
    </div>
  );
}

interface StepProps {
  form: WorkspaceSetupInput;
  errors: SetupErrors;
  update: <K extends keyof WorkspaceSetupInput>(key: K, value: WorkspaceSetupInput[K]) => void;
}

function HotelStep({ form, errors, update }: StepProps) {
  return (
    <>
      <StepHeading
        icon={<Building2 size={22} />}
        title="Tell us about your hotel"
        subtitle="This is how your hotel appears across InnPilot."
      />
      <div className="space-y-5">
        <SetupField id="hotelName" label="Hotel name" error={errors.hotelName}>
          <input
            id="hotelName"
            className="input h-12 text-[15px]"
            placeholder="e.g. Kampala Grand Hotel"
            value={form.hotelName}
            onChange={(e) => update("hotelName", e.target.value)}
            aria-invalid={!!errors.hotelName}
            aria-describedby={errors.hotelName ? "hotelName-error" : undefined}
            autoComplete="organization"
            autoFocus
          />
        </SetupField>

        <SetupField id="city" label="City" error={errors.city}>
          <input
            id="city"
            className="input h-12 text-[15px]"
            placeholder="e.g. Kampala"
            value={form.city}
            onChange={(e) => update("city", e.target.value)}
            aria-invalid={!!errors.city}
            aria-describedby={errors.city ? "city-error" : undefined}
            autoComplete="address-level2"
          />
        </SetupField>

        <SetupField id="currency" label="Currency" error={errors.currency} hint="Every price and report uses this currency.">
          <div role="radiogroup" aria-label="Currency" id="currency" className="grid grid-cols-4 gap-2">
            {CURRENCIES.map((currency) => {
              const selected = form.currency === currency;
              return (
                <button
                  key={currency}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => update("currency", currency)}
                  className="h-11 rounded-lg text-sm font-semibold transition-colors"
                  style={{
                    border: `1.5px solid ${selected ? "var(--primary)" : "var(--border)"}`,
                    background: selected ? "var(--primary-soft)" : "var(--surface)",
                    color: selected ? "var(--primary-active)" : "var(--text-secondary)",
                  }}
                >
                  {currency}
                </button>
              );
            })}
          </div>
        </SetupField>
      </div>
    </>
  );
}

function BusinessStep({ form, errors, update }: StepProps) {
  const setRooms = (value: number) =>
    update("roomCount", Math.min(MAX_ROOMS, Math.max(MIN_ROOMS, value)));

  return (
    <>
      <StepHeading
        icon={<Phone size={22} />}
        title="Business details"
        subtitle="How guests reach you, and how many rooms you run."
      />
      <div className="space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <SetupField id="phone" label="Phone number" optional error={errors.phone}>
            <input
              id="phone"
              type="tel"
              className="input h-12 text-[15px]"
              placeholder="+256 700 123 456"
              value={form.phone}
              onChange={(e) => update("phone", e.target.value)}
              aria-invalid={!!errors.phone}
              aria-describedby={errors.phone ? "phone-error" : undefined}
              autoComplete="tel"
              autoFocus
            />
          </SetupField>

          <SetupField id="email" label="Email" optional error={errors.email}>
            <input
              id="email"
              type="email"
              className="input h-12 text-[15px]"
              placeholder="reservations@hotel.com"
              value={form.email}
              onChange={(e) => update("email", e.target.value)}
              aria-invalid={!!errors.email}
              aria-describedby={errors.email ? "email-error" : undefined}
              autoComplete="email"
            />
          </SetupField>
        </div>

        <SetupField
          id="roomCount"
          label="Number of rooms"
          error={errors.roomCount}
          hint="We'll set up this many rooms with starting rates. You can add more later."
        >
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn btn-secondary h-12 w-12 p-0 justify-center"
              onClick={() => setRooms((form.roomCount || MIN_ROOMS) - 1)}
              aria-label="Fewer rooms"
            >
              <Minus size={16} />
            </button>
            <input
              id="roomCount"
              type="number"
              inputMode="numeric"
              min={MIN_ROOMS}
              max={MAX_ROOMS}
              className="input h-12 w-28 text-center text-lg font-semibold"
              value={form.roomCount || ""}
              onChange={(e) =>
                update("roomCount", e.target.value === "" ? 0 : Math.floor(Number(e.target.value)))
              }
              aria-invalid={!!errors.roomCount}
              aria-describedby={errors.roomCount ? "roomCount-error" : undefined}
            />
            <button
              type="button"
              className="btn btn-secondary h-12 w-12 p-0 justify-center"
              onClick={() => setRooms((form.roomCount || 0) + 1)}
              aria-label="More rooms"
            >
              <Plus size={16} />
            </button>
            <span className="text-sm muted ml-1">rooms</span>
          </div>
        </SetupField>
      </div>
    </>
  );
}

function ReviewStep({
  form,
  rooms,
  onEdit,
}: {
  form: WorkspaceSetupInput;
  rooms: ReturnType<typeof summarizeRooms>;
  onEdit: (step: Step) => void;
}) {
  const editButton = (target: Step, label: string) => (
    <button
      type="button"
      className="text-xs font-semibold"
      style={{ color: "var(--primary)" }}
      onClick={() => onEdit(target)}
      aria-label={label}
    >
      Edit
    </button>
  );

  return (
    <>
      <StepHeading
        icon={<Sparkles size={22} />}
        title="Create your workspace"
        subtitle="Check the details below. You can change any of them later in Settings."
      />

      <div className="rounded-xl p-5" style={{ background: "var(--surface-muted)" }}>
        <div className="flex items-start gap-3">
          <span
            className="w-10 h-10 rounded-lg flex items-center justify-center flex-none"
            style={{ background: "var(--surface)", color: "var(--primary)" }}
          >
            <Building2 size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-base truncate" style={{ color: "var(--text)" }}>
              {form.hotelName.trim()}
            </p>
            <p className="text-sm muted">
              {form.city.trim()} · {form.currency}
            </p>
          </div>
          {editButton(0, "Edit hotel information")}
        </div>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4 text-sm">
          <div className="min-w-0">
            <dt className="text-xs muted">Phone</dt>
            <dd className="truncate" style={{ color: "var(--text-secondary)" }}>
              {form.phone.trim() || "Not provided"}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs muted">Email</dt>
            <dd className="truncate" style={{ color: "var(--text-secondary)" }}>
              {form.email.trim() || "Not provided"}
            </dd>
          </div>
        </dl>
      </div>

      <div className="mt-5">
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>
            {plural(form.roomCount, "room")} with starting rates
          </p>
          {editButton(1, "Edit number of rooms")}
        </div>
        <ul className="rounded-xl overflow-hidden" style={{ border: "1px solid var(--border)" }}>
          {rooms.map((row, index) => (
            <li
              key={row.type}
              className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
              style={{
                borderTop: index === 0 ? "none" : "1px solid var(--border)",
                background: "var(--surface)",
              }}
            >
              <span className="flex items-center gap-2" style={{ color: "var(--text)" }}>
                <BedDouble size={15} style={{ color: "var(--text-muted)" }} />
                {plural(row.count, `${row.type} room`)}
              </span>
              <span className="font-medium tabular-nums" style={{ color: "var(--text)" }}>
                {money(row.price, form.currency)}
                <span className="muted font-normal"> / night</span>
              </span>
            </li>
          ))}
        </ul>
        <p className="text-xs muted mt-2">
          Starting rates are a guide based on typical local prices. Add or change rooms any time
          from Accommodation.
        </p>
      </div>
    </>
  );
}
