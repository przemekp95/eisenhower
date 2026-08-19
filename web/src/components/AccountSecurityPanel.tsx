import LanguageSwitcher from './LanguageSwitcher';
import { buildAccountManagementUrl } from '../oidcSession';
import { useLanguage } from '../i18n/LanguageContext';

interface Props {
  issuer?: string;
  onLogout: () => void;
}

export default function AccountSecurityPanel({ issuer, onLogout }: Props) {
  const { t } = useLanguage();
  const accountUrl = buildAccountManagementUrl(issuer);

  return (
    <section className="rounded-3xl border border-white/10 bg-slate-900/80 p-5">
      <h2 className="text-2xl font-semibold">{t('account.heading')}</h2>
      <div className="mt-5 space-y-6">
        <div>
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-[0.16em] text-white/60">
            {t('account.language')}
          </h3>
          <LanguageSwitcher />
        </div>
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-[0.16em] text-white/60">
            {t('account.passwordHeading')}
          </h3>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-white/65">
            {t('account.passwordHelp')}
          </p>
          {accountUrl ? (
            <a
              href={accountUrl}
              className="mt-3 inline-flex min-h-11 items-center rounded-xl border border-cyan-200/25 bg-cyan-300/10 px-4 py-2 text-sm font-semibold text-cyan-50"
            >
              {t('account.passwordAction')}
            </a>
          ) : (
            <p className="mt-3 text-sm text-amber-200">{t('account.passwordUnavailable')}</p>
          )}
        </div>
        <button
          type="button"
          onClick={onLogout}
          className="min-h-11 rounded-xl border border-white/15 px-4 py-2 text-sm font-semibold hover:bg-white/10"
        >
          {t('auth.logout')}
        </button>
      </div>
    </section>
  );
}
