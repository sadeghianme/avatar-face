import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { FieldError } from "@/components/ui/FieldError";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { StackCell, StackRow, StackTable, TableAction } from "@/components/ui/Table";
import {
  useChangeRole,
  useInvitations,
  useInvite,
  useMembers,
  useRemoveMember,
  useRevokeInvitation,
} from "@/features/members/api";
import { useT } from "@/i18n";
import { errorMessage } from "@/lib/errorMessage";
import type { Role } from "@/lib/types";
import { useOrg } from "@/providers/org";

export function MembersPage() {
  const { t } = useT();
  const { current } = useOrg();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const orgId = current?.id;
  const isAdmin = current?.role === "owner" || current?.role === "admin";

  const { data: members } = useMembers(orgId);
  const { data: invitations } = useInvitations(orgId, isAdmin);
  const invite = useInvite(orgId);
  const changeRole = useChangeRole(orgId);
  const remove = useRemoveMember(orgId);
  const revoke = useRevokeInvitation(orgId);
  // The last action's refusal, whichever it was.
  const failed = invite.error ?? changeRole.error ?? remove.error ?? revoke.error;
  const pending = invitations?.filter((i) => !i.accepted_at && !i.revoked_at) ?? [];

  const roleOptions = (withOwner: boolean) => (
    <>
      <option value="member">{t("roles.member")}</option>
      <option value="admin">{t("roles.admin")}</option>
      {withOwner && <option value="owner">{t("roles.owner")}</option>}
    </>
  );

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">{t("members")}</h1>

      {isAdmin && (
        <Card
          as="form"
          className="mb-6 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            invite.mutate({ email, role }, { onSuccess: () => setEmail("") });
          }}
        >
          <Field id="invite-email" label={t("inviteMember")} className="min-w-48 flex-1">
            <Input
              type="email"
              required
              placeholder="teammate@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field id="invite-role" label={t("role")}>
            <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {roleOptions(current?.role === "owner")}
            </Select>
          </Field>
          <Button type="submit" disabled={invite.isPending}>
            {t("inviteMember")}
          </Button>
        </Card>
      )}
      {failed && <FieldError className="mb-4">{errorMessage(failed, t("error"))}</FieldError>}

      <Card padding="none" className="overflow-x-auto">
        <StackTable>
          {members?.map((member) => (
            <StackRow key={member.membership_id}>
              <StackCell kind="lead">
                <div className="font-medium">{member.display_name || member.username}</div>
                <div className="text-xs text-gray-400">{member.email}</div>
              </StackCell>
              <StackCell>
                {isAdmin ? (
                  <Select
                    aria-label={`role-${member.username}`}
                    className="w-auto py-1"
                    value={member.role}
                    onChange={(e) =>
                      changeRole.mutate({ membershipId: member.membership_id, role: e.target.value as Role })
                    }
                  >
                    {roleOptions(true)}
                  </Select>
                ) : (
                  t(`roles.${member.role}`)
                )}
              </StackCell>
              <StackCell kind="end">
                {isAdmin && (
                  <TableAction onClick={() => remove.mutate(member.membership_id)}>{t("delete")}</TableAction>
                )}
              </StackCell>
            </StackRow>
          ))}
        </StackTable>
      </Card>

      {isAdmin && pending.length > 0 && (
        <>
          <h2 className="mb-3 mt-8 text-lg font-medium">{t("pendingInvitations")}</h2>
          <Card padding="none">
            <StackTable>
              {pending.map((invitation) => (
                <StackRow key={invitation.id}>
                  <StackCell kind="lead">
                    <div>{invitation.email}</div>
                  </StackCell>
                  <StackCell>{t(`roles.${invitation.role}`)}</StackCell>
                  <StackCell className="text-xs text-gray-400">
                    <code>/invite/{invitation.token.slice(0, 12)}…</code>
                    <TableAction
                      tone="brand"
                      className="ms-2"
                      onClick={() =>
                        void navigator.clipboard.writeText(`${window.location.origin}/invite/${invitation.token}`)
                      }
                    >
                      {t("copy")}
                    </TableAction>
                  </StackCell>
                  <StackCell kind="end">
                    <TableAction onClick={() => revoke.mutate(invitation.id)}>{t("revoke")}</TableAction>
                  </StackCell>
                </StackRow>
              ))}
            </StackTable>
          </Card>
        </>
      )}
    </div>
  );
}
