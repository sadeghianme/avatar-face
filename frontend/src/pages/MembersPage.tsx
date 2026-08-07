import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { api, ApiError } from "../lib/api";
import { useOrg } from "../lib/org";
import type { Invitation, Member, Role } from "../lib/types";

export function MembersPage() {
  const { t } = useTranslation();
  const { current } = useOrg();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [error, setError] = useState<string | null>(null);
  const orgId = current?.id;
  const isAdmin = current?.role === "owner" || current?.role === "admin";

  const { data: members } = useQuery({
    queryKey: ["members", orgId],
    queryFn: () => api.get<Member[]>(`/orgs/${orgId}/members`),
    enabled: Boolean(orgId),
  });
  const { data: invitations } = useQuery({
    queryKey: ["invitations", orgId],
    queryFn: () => api.get<Invitation[]>(`/orgs/${orgId}/invitations`),
    enabled: Boolean(orgId) && isAdmin,
  });

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["members", orgId] }),
      queryClient.invalidateQueries({ queryKey: ["invitations", orgId] }),
    ]);

  const invite = useMutation({
    mutationFn: () => api.post(`/orgs/${orgId}/invitations`, { email, role }),
    onSuccess: () => {
      setEmail("");
      setError(null);
      void invalidate();
    },
    onError: (err) => setError(err instanceof ApiError ? err.detail : t("error")),
  });

  const changeRole = async (member: Member, newRole: Role) => {
    setError(null);
    try {
      await api.patch(`/orgs/${orgId}/members/${member.membership_id}`, { role: newRole });
      await invalidate();
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : t("error"));
    }
  };

  const removeMember = async (member: Member) => {
    setError(null);
    try {
      await api.delete(`/orgs/${orgId}/members/${member.membership_id}`);
      await invalidate();
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : t("error"));
    }
  };

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-6 text-2xl font-semibold">{t("members")}</h1>

      {isAdmin && (
        <form
          className="card mb-6 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            invite.mutate();
          }}
        >
          <div className="min-w-48 flex-1">
            <label className="label" htmlFor="invite-email">{t("inviteMember")}</label>
            <input
              id="invite-email"
              type="email"
              required
              className="input"
              placeholder="teammate@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="invite-role">{t("role")}</label>
            <select
              id="invite-role"
              className="input"
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
            >
              <option value="member">{t("roles.member")}</option>
              <option value="admin">{t("roles.admin")}</option>
              {current?.role === "owner" && <option value="owner">{t("roles.owner")}</option>}
            </select>
          </div>
          <button type="submit" className="btn-primary" disabled={invite.isPending}>
            {t("inviteMember")}
          </button>
        </form>
      )}
      {error && <p className="field-error mb-4">{error}</p>}

      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <tbody>
            {members?.map((member) => (
              <tr
                key={member.membership_id}
                className="border-b border-gray-100 last:border-0 dark:border-line"
              >
                <td className="px-5 py-3">
                  <div className="font-medium">{member.display_name || member.username}</div>
                  <div className="text-xs text-gray-400">{member.email}</div>
                </td>
                <td className="px-5 py-3">
                  {isAdmin ? (
                    <select
                      aria-label={`role-${member.username}`}
                      className="input w-auto py-1"
                      value={member.role}
                      onChange={(e) => void changeRole(member, e.target.value as Role)}
                    >
                      <option value="member">{t("roles.member")}</option>
                      <option value="admin">{t("roles.admin")}</option>
                      <option value="owner">{t("roles.owner")}</option>
                    </select>
                  ) : (
                    t(`roles.${member.role}`)
                  )}
                </td>
                <td className="px-5 py-3 text-end">
                  {isAdmin && (
                    <button
                      className="text-sm text-red-600 hover:underline"
                      onClick={() => void removeMember(member)}
                    >
                      {t("delete")}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {isAdmin && invitations && invitations.filter((i) => !i.accepted_at && !i.revoked_at).length > 0 && (
        <>
          <h2 className="mb-3 mt-8 text-lg font-medium">{t("pendingInvitations")}</h2>
          <div className="card p-0">
            <table className="w-full text-sm">
              <tbody>
                {invitations
                  .filter((i) => !i.accepted_at && !i.revoked_at)
                  .map((invitation) => (
                    <tr
                      key={invitation.id}
                      className="border-b border-gray-100 last:border-0 dark:border-line"
                    >
                      <td className="px-5 py-3">{invitation.email}</td>
                      <td className="px-5 py-3">{t(`roles.${invitation.role}`)}</td>
                      <td className="px-5 py-3 text-xs text-gray-400">
                        <code>/invite/{invitation.token.slice(0, 12)}…</code>
                        <button
                          className="ms-2 text-brand-600 hover:underline"
                          onClick={() =>
                            void navigator.clipboard.writeText(
                              `${window.location.origin}/invite/${invitation.token}`
                            )
                          }
                        >
                          {t("copy")}
                        </button>
                      </td>
                      <td className="px-5 py-3 text-end">
                        <button
                          className="text-sm text-red-600 hover:underline"
                          onClick={async () => {
                            await api.delete(`/orgs/${orgId}/invitations/${invitation.id}`);
                            await invalidate();
                          }}
                        >
                          {t("revoke")}
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
