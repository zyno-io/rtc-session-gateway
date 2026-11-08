// Generated from proto/sipbridge-control.proto. Do not edit.

export interface JsonField {
    kind: 'uint64' | 'uint32' | 'boolean' | 'string' | 'bytes' | 'enum' | 'message';
    values?: readonly string[];
    message?: string;
    repeated?: boolean;
    map?: boolean;
    oneof?: string;
    alias?: string;
}
export interface JsonMessage {
    fields: Record<string, JsonField>;
    oneofs: readonly string[];
}
export const SIPBRIDGE_JSON_MESSAGES: Record<string, JsonMessage> = {
    '.zyno.sipbridge.v1.Envelope': {
        fields: {
            correlationId: {
                kind: 'string',
                alias: 'correlation_id'
            },
            sessionId: {
                kind: 'string',
                alias: 'session_id'
            },
            remainingBudgetMs: {
                kind: 'uint32',
                alias: 'remaining_budget_ms'
            },
            hello: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.SessionHello',
                oneof: 'payload'
            },
            helloAck: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.SessionHelloAck',
                oneof: 'payload',
                alias: 'hello_ack'
            },
            status: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.SessionStatus',
                oneof: 'payload'
            },
            ping: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.Heartbeat',
                oneof: 'payload'
            },
            pong: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.Heartbeat',
                oneof: 'payload'
            },
            ingress: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.IngressReceived',
                oneof: 'payload'
            },
            routeResult: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.RouteResult',
                oneof: 'payload',
                alias: 'route_result'
            },
            ingest: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.OwnerIngest',
                oneof: 'payload'
            },
            request: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.RequestPresented',
                oneof: 'payload'
            },
            command: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.Command',
                oneof: 'payload'
            },
            result: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.OperationResult',
                oneof: 'payload'
            },
            egress: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.EgressRequest',
                oneof: 'payload'
            },
            write: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.FlowWrite',
                oneof: 'payload'
            },
            delivery: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.DeliveryResult',
                oneof: 'payload'
            },
            flowClosed: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.FlowClosed',
                oneof: 'payload',
                alias: 'flow_closed'
            },
            dialogEvent: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.DialogEvent',
                oneof: 'payload',
                alias: 'dialog_event'
            },
            inspect: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ContextInspect',
                oneof: 'payload'
            },
            flowAdoption: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.FlowAdoptionRequest',
                oneof: 'payload',
                alias: 'flow_adoption'
            },
            flowAdoptionResult: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.FlowAdoptionResult',
                oneof: 'payload',
                alias: 'flow_adoption_result'
            },
            sendPermit: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.SendPermit',
                oneof: 'payload',
                alias: 'send_permit'
            },
            deliverEffect: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.FlowWrite',
                oneof: 'payload',
                alias: 'deliver_effect'
            },
            credentialLookup: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.CredentialLookup',
                oneof: 'payload',
                alias: 'credential_lookup'
            },
            credentialResult: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.CredentialResult',
                oneof: 'payload',
                alias: 'credential_result'
            },
            inspectEffect: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.FlowWrite',
                oneof: 'payload',
                alias: 'inspect_effect'
            },
            settleEffect: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.EffectSettlement',
                oneof: 'payload',
                alias: 'settle_effect'
            },
            retireAuthority: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ContextSnapshot',
                oneof: 'payload',
                alias: 'retire_authority'
            },
            probeApplication: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ApplicationProbe',
                oneof: 'payload',
                alias: 'probe_application'
            },
            applicationStatus: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ApplicationStatus',
                oneof: 'payload',
                alias: 'application_status'
            },
            reconcileContext: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ContextReconcile',
                oneof: 'payload',
                alias: 'reconcile_context'
            },
            reconcileAuthority: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.AuthorityReconcile',
                oneof: 'payload',
                alias: 'reconcile_authority'
            },
            authorityReceipt: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.AuthorityReceipt',
                oneof: 'payload',
                alias: 'authority_receipt'
            }
        },
        oneofs: ['payload']
    },
    '.zyno.sipbridge.v1.ProcessRef': {
        fields: {
            instanceId: {
                kind: 'string',
                alias: 'instance_id'
            },
            epoch: {
                kind: 'string'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.Bounds': {
        fields: {
            maxEnvelopeBytes: {
                kind: 'uint32',
                alias: 'max_envelope_bytes'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.SessionHello': {
        fields: {
            nexus: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ProcessRef'
            },
            connectionAttempt: {
                kind: 'uint64',
                alias: 'connection_attempt'
            },
            major: {
                kind: 'uint32'
            },
            minMinor: {
                kind: 'uint32',
                alias: 'min_minor'
            },
            maxMinor: {
                kind: 'uint32',
                alias: 'max_minor'
            },
            capabilities: {
                kind: 'string',
                repeated: true
            },
            bounds: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.Bounds'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.SessionHelloAck': {
        fields: {
            sipbridge: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ProcessRef'
            },
            sessionId: {
                kind: 'string',
                alias: 'session_id'
            },
            major: {
                kind: 'uint32'
            },
            minor: {
                kind: 'uint32'
            },
            capabilities: {
                kind: 'string',
                repeated: true
            },
            bounds: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.Bounds'
            },
            heartbeatIntervalMs: {
                kind: 'uint32',
                alias: 'heartbeat_interval_ms'
            },
            heartbeatTimeoutMs: {
                kind: 'uint32',
                alias: 'heartbeat_timeout_ms'
            },
            stateAuthority: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.StateAuthority',
                alias: 'state_authority'
            },
            applicationLease: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ApplicationLease',
                alias: 'application_lease'
            },
            inboundAuthPolicy: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.InboundAuthPolicy',
                alias: 'inbound_auth_policy'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.ApplicationLease': {
        fields: {
            application: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ProcessRef'
            },
            authority: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.StateAuthority'
            },
            term: {
                kind: 'string'
            },
            checkedAtMs: {
                kind: 'uint64',
                alias: 'checked_at_ms'
            },
            expiresAtMs: {
                kind: 'uint64',
                alias: 'expires_at_ms'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.SessionStatus': {
        fields: {
            retainedReady: {
                kind: 'boolean',
                alias: 'retained_ready'
            },
            admitCalls: {
                kind: 'boolean',
                alias: 'admit_calls'
            },
            admitSubscriptions: {
                kind: 'boolean',
                alias: 'admit_subscriptions'
            },
            bindingsReady: {
                kind: 'boolean',
                alias: 'bindings_ready'
            },
            draining: {
                kind: 'boolean'
            },
            digestChallengePolicy: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.DigestChallengePolicy',
                alias: 'digest_challenge_policy'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.InboundAuthPolicy': {
        fields: {
            requireRegister: {
                kind: 'boolean',
                alias: 'require_register'
            },
            requireInvite: {
                kind: 'boolean',
                alias: 'require_invite'
            },
            requireSubscribe: {
                kind: 'boolean',
                alias: 'require_subscribe'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.DigestChallengePolicy': {
        fields: {
            realm: {
                kind: 'string'
            },
            authenticationEpoch: {
                kind: 'string',
                alias: 'authentication_epoch'
            },
            signingKey: {
                kind: 'bytes',
                alias: 'signing_key'
            },
            expiresAtMs: {
                kind: 'uint64',
                alias: 'expires_at_ms'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.Heartbeat': {
        fields: {
            nonce: {
                kind: 'string'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.FlowRef': {
        fields: {
            ingress: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ProcessRef'
            },
            connectionId: {
                kind: 'string',
                alias: 'connection_id'
            },
            sourceIp: {
                kind: 'string',
                alias: 'source_ip'
            },
            sourcePort: {
                kind: 'uint32',
                alias: 'source_port'
            },
            listener: {
                kind: 'string'
            },
            transport: {
                kind: 'string'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.StateAuthority': {
        fields: {
            service: {
                kind: 'string'
            },
            generation: {
                kind: 'string'
            },
            primaryId: {
                kind: 'string',
                alias: 'primary_id'
            },
            schemaVersion: {
                kind: 'uint32',
                alias: 'schema_version'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.StateRef': {
        fields: {
            authority: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.StateAuthority'
            },
            groupId: {
                kind: 'string',
                alias: 'group_id'
            },
            incarnation: {
                kind: 'string'
            },
            callId: {
                kind: 'string',
                alias: 'call_id'
            },
            partition: {
                kind: 'uint32'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.ContextRef': {
        fields: {
            owner: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ProcessRef'
            },
            id: {
                kind: 'string'
            },
            state: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.StateRef'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.Header': {
        fields: {
            name: {
                kind: 'string'
            },
            value: {
                kind: 'string'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.Address': {
        fields: {
            name: {
                kind: 'string'
            },
            uri: {
                kind: 'string'
            },
            params: {
                kind: 'string',
                map: true
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.AddressList': {
        fields: {
            values: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.Address',
                repeated: true
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.Via': {
        fields: {
            protocol: {
                kind: 'string'
            },
            host: {
                kind: 'string'
            },
            port: {
                kind: 'uint32'
            },
            params: {
                kind: 'string',
                map: true
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.DigestCredentials': {
        fields: {
            username: {
                kind: 'string'
            },
            realm: {
                kind: 'string'
            },
            nonce: {
                kind: 'string'
            },
            uri: {
                kind: 'string'
            },
            response: {
                kind: 'string'
            },
            algorithm: {
                kind: 'string'
            },
            qop: {
                kind: 'string'
            },
            nc: {
                kind: 'string'
            },
            cnonce: {
                kind: 'string'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.SipMessage': {
        fields: {
            wire: {
                kind: 'bytes'
            },
            method: {
                kind: 'string'
            },
            uri: {
                kind: 'string'
            },
            status: {
                kind: 'uint32'
            },
            reason: {
                kind: 'string'
            },
            body: {
                kind: 'bytes'
            },
            headers: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.Header',
                repeated: true
            },
            addresses: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.AddressList',
                map: true
            },
            vias: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.Via',
                repeated: true
            },
            selectors: {
                kind: 'string',
                repeated: true
            },
            authorization: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.DigestCredentials'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.IngressReceived': {
        fields: {
            flow: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.FlowRef'
            },
            message: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.SipMessage'
            },
            context: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ContextRef'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.RouteResult': {
        fields: {
            outcome: {
                kind: 'enum',
                values: ['UNSPECIFIED', 'ACCEPTED', 'REDIRECT', 'REJECTED', 'UNAVAILABLE']
            },
            nexus: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ProcessRef'
            },
            sipStatus: {
                kind: 'uint32',
                alias: 'sip_status'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.OwnerIngest': {
        fields: {
            context: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ContextRef'
            },
            application: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ProcessRef'
            },
            flow: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.FlowRef'
            },
            wire: {
                kind: 'bytes'
            },
            bindingId: {
                kind: 'string',
                alias: 'binding_id'
            },
            principalId: {
                kind: 'string',
                alias: 'principal_id'
            },
            authenticated: {
                kind: 'boolean'
            },
            admission: {
                kind: 'enum',
                values: ['UNSPECIFIED', 'EXISTING_FLOW', 'AUTHENTICATED_BINDING', 'TLS_DIALOG_CONTINUITY', 'TLS_TRANSACTION_CONTINUITY']
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.ContextSnapshot': {
        fields: {
            context: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ContextRef'
            },
            application: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ProcessRef'
            },
            bindingId: {
                kind: 'string',
                alias: 'binding_id'
            },
            principalId: {
                kind: 'string',
                alias: 'principal_id'
            },
            kind: {
                kind: 'enum',
                values: ['UNKNOWN', 'TRANSACTION', 'UAS', 'UAC', 'SUBSCRIPTION']
            },
            dialogId: {
                kind: 'string',
                alias: 'dialog_id'
            },
            callId: {
                kind: 'string',
                alias: 'call_id'
            },
            localTag: {
                kind: 'string',
                alias: 'local_tag'
            },
            remoteTag: {
                kind: 'string',
                alias: 'remote_tag'
            },
            localUri: {
                kind: 'string',
                alias: 'local_uri'
            },
            remoteUri: {
                kind: 'string',
                alias: 'remote_uri'
            },
            remoteTarget: {
                kind: 'string',
                alias: 'remote_target'
            },
            localSdp: {
                kind: 'bytes',
                alias: 'local_sdp'
            },
            remoteSdp: {
                kind: 'bytes',
                alias: 'remote_sdp'
            },
            answered: {
                kind: 'boolean'
            },
            initialAck: {
                kind: 'boolean',
                alias: 'initial_ack'
            },
            ended: {
                kind: 'boolean'
            },
            revision: {
                kind: 'uint64'
            },
            commandSequence: {
                kind: 'uint64',
                alias: 'command_sequence'
            },
            selectors: {
                kind: 'string',
                repeated: true
            },
            transport: {
                kind: 'string'
            },
            delivery: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ContextDelivery'
            },
            executor: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ProcessRef'
            },
            directoryEpoch: {
                kind: 'string',
                alias: 'directory_epoch'
            },
            applicationLeaseTerm: {
                kind: 'string',
                alias: 'application_lease_term'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.RequestPresented': {
        fields: {
            snapshot: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ContextSnapshot'
            },
            requestId: {
                kind: 'string',
                alias: 'request_id'
            },
            message: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.SipMessage'
            },
            flow: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.FlowRef'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.ResponseAuthority': {
        fields: {
            directoryEpoch: {
                kind: 'string',
                alias: 'directory_epoch'
            },
            completionScope: {
                kind: 'string',
                alias: 'completion_scope'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.Respond': {
        fields: {
            requestId: {
                kind: 'string',
                alias: 'request_id'
            },
            status: {
                kind: 'uint32'
            },
            headers: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.Header',
                repeated: true
            },
            body: {
                kind: 'bytes'
            },
            principalId: {
                kind: 'string',
                alias: 'principal_id'
            },
            bindingId: {
                kind: 'string',
                alias: 'binding_id'
            },
            authority: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ResponseAuthority'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.CredentialRef': {
        fields: {
            id: {
                kind: 'string'
            },
            version: {
                kind: 'string'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.CredentialLookup': {
        fields: {
            context: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ContextRef'
            },
            credential: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.CredentialRef'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.CredentialResult': {
        fields: {
            username: {
                kind: 'string'
            },
            password: {
                kind: 'string'
            },
            version: {
                kind: 'string'
            },
            error: {
                kind: 'string'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.NetworkTarget': {
        fields: {
            proxy: {
                kind: 'string'
            },
            transport: {
                kind: 'string'
            },
            username: {
                kind: 'string'
            },
            password: {
                kind: 'string'
            },
            credential: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.CredentialRef'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.OpenUac': {
        fields: {
            uri: {
                kind: 'string'
            },
            body: {
                kind: 'bytes'
            },
            headers: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.Header',
                repeated: true
            },
            bindingId: {
                kind: 'string',
                alias: 'binding_id'
            },
            principalId: {
                kind: 'string',
                alias: 'principal_id'
            },
            network: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.NetworkTarget'
            },
            transport: {
                kind: 'string'
            },
            method: {
                kind: 'string'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.DialogRequest': {
        fields: {
            method: {
                kind: 'string'
            },
            body: {
                kind: 'bytes'
            },
            headers: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.Header',
                repeated: true
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.Cancel': {
        fields: {},
        oneofs: []
    },
    '.zyno.sipbridge.v1.CommandAdmission': {
        fields: {
            directoryEpoch: {
                kind: 'string',
                alias: 'directory_epoch'
            },
            expiresAtMs: {
                kind: 'uint64',
                alias: 'expires_at_ms'
            },
            selectedFlow: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.FlowRef',
                alias: 'selected_flow'
            },
            expectedDelivery: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ContextDelivery',
                alias: 'expected_delivery'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.Command': {
        fields: {
            context: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ContextRef'
            },
            sequence: {
                kind: 'uint64'
            },
            admission: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.CommandAdmission'
            },
            respond: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.Respond',
                oneof: 'action'
            },
            openUac: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.OpenUac',
                oneof: 'action',
                alias: 'open_uac'
            },
            dialogRequest: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.DialogRequest',
                oneof: 'action',
                alias: 'dialog_request'
            },
            cancel: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.Cancel',
                oneof: 'action'
            }
        },
        oneofs: ['action']
    },
    '.zyno.sipbridge.v1.OperationResult': {
        fields: {
            certainty: {
                kind: 'enum',
                values: ['UNSPECIFIED', 'NOT_ACCEPTED', 'ACCEPTED', 'COMPLETED', 'UNKNOWN']
            },
            error: {
                kind: 'string'
            },
            sipStatus: {
                kind: 'uint32',
                alias: 'sip_status'
            },
            snapshot: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ContextSnapshot'
            },
            request: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.SipMessage'
            },
            response: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.SipMessage'
            },
            retirementProof: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ContextRetirementProof',
                alias: 'retirement_proof'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.ContextRetirementProof': {
        fields: {
            context: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ContextRef'
            },
            authority: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.StateAuthority'
            },
            reason: {
                kind: 'enum',
                values: ['UNSPECIFIED', 'GROUP_ABSENT', 'OBSOLETE_INCARNATION', 'CONTEXT_ABSENT']
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.StateEffectRef': {
        fields: {
            context: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ContextRef'
            },
            id: {
                kind: 'string'
            },
            attemptId: {
                kind: 'string',
                alias: 'attempt_id'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.EffectAuthorization': {
        fields: {
            effect: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.StateEffectRef'
            },
            authorityClass: {
                kind: 'enum',
                values: ['UNSPECIFIED', 'APPLICATION', 'NATIVE_COMPLETION', 'TERMINAL_CLEANUP', 'RESPONSE'],
                alias: 'authority_class'
            },
            completionScope: {
                kind: 'string',
                alias: 'completion_scope'
            },
            fingerprint: {
                kind: 'string'
            },
            deadlineMs: {
                kind: 'uint64',
                alias: 'deadline_ms'
            },
            applicationLeaseTerm: {
                kind: 'string',
                alias: 'application_lease_term'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.SendPermit': {
        fields: {
            authorization: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.EffectAuthorization'
            },
            flow: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.FlowRef'
            },
            directoryEpoch: {
                kind: 'string',
                alias: 'directory_epoch'
            },
            orderingProof: {
                kind: 'string',
                alias: 'ordering_proof'
            },
            completionScope: {
                kind: 'string',
                alias: 'completion_scope'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.EgressRequest': {
        fields: {
            snapshot: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ContextSnapshot'
            },
            message: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.SipMessage'
            },
            returnFlow: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.FlowRef',
                alias: 'return_flow'
            },
            authorization: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.EffectAuthorization'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.FlowWrite': {
        fields: {
            flow: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.FlowRef'
            },
            bindingId: {
                kind: 'string',
                alias: 'binding_id'
            },
            bindingRevision: {
                kind: 'uint64',
                alias: 'binding_revision'
            },
            wire: {
                kind: 'bytes'
            },
            effect: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.StateEffectRef'
            },
            permit: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.SendPermit'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.DeliveryResult': {
        fields: {
            outcome: {
                kind: 'enum',
                values: ['UNSPECIFIED', 'WRITTEN', 'NOT_WRITTEN', 'UNKNOWN']
            },
            error: {
                kind: 'string'
            },
            effect: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.StateEffectRef'
            },
            recorded: {
                kind: 'boolean'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.EffectSettlement': {
        fields: {
            write: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.FlowWrite'
            },
            delivery: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.DeliveryResult'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.ApplicationProbe': {
        fields: {
            context: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ContextRef'
            },
            application: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ProcessRef'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.ApplicationStatus': {
        fields: {
            context: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ContextRef'
            },
            application: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ProcessRef'
            },
            directoryEpoch: {
                kind: 'string',
                alias: 'directory_epoch'
            },
            live: {
                kind: 'boolean'
            },
            checkedAtMs: {
                kind: 'uint64',
                alias: 'checked_at_ms'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.FlowClosed': {
        fields: {
            flow: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.FlowRef'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.DialogEvent': {
        fields: {
            kind: {
                kind: 'enum',
                values: ['UNSPECIFIED', 'PROVISIONAL', 'ANSWERED', 'ACKNOWLEDGED', 'CANCELLED', 'ENDED', 'FAILED', 'SUBSCRIPTION_EXPIRED']
            },
            snapshot: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ContextSnapshot'
            },
            message: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.SipMessage'
            },
            operationId: {
                kind: 'string',
                alias: 'operation_id'
            },
            error: {
                kind: 'string'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.ContextInspect': {
        fields: {
            context: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ContextRef'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.ContextDelivery': {
        fields: {
            flow: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.FlowRef'
            },
            nativeRevision: {
                kind: 'uint64',
                alias: 'native_revision'
            },
            directoryEpoch: {
                kind: 'string',
                alias: 'directory_epoch'
            },
            registrationTicket: {
                kind: 'string',
                alias: 'registration_ticket'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.FlowAdoptionRequest': {
        fields: {
            context: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ContextRef'
            },
            application: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ProcessRef'
            },
            principalId: {
                kind: 'string',
                alias: 'principal_id'
            },
            bindingId: {
                kind: 'string',
                alias: 'binding_id'
            },
            flow: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.FlowRef'
            },
            nativeRevision: {
                kind: 'uint64',
                alias: 'native_revision'
            },
            subscription: {
                kind: 'boolean'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.FlowAdoptionResult': {
        fields: {
            receipt: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ContextDelivery'
            },
            error: {
                kind: 'string'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.ContextReconcile': {
        fields: {
            context: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ContextRef'
            },
            fromDirectoryEpoch: {
                kind: 'string',
                alias: 'from_directory_epoch'
            },
            directoryEpoch: {
                kind: 'string',
                alias: 'directory_epoch'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.AuthorityReconcile': {
        fields: {
            snapshot: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ContextSnapshot'
            },
            fromDirectoryEpoch: {
                kind: 'string',
                alias: 'from_directory_epoch'
            },
            directoryEpoch: {
                kind: 'string',
                alias: 'directory_epoch'
            },
            token: {
                kind: 'string'
            },
            barrierRevision: {
                kind: 'uint64',
                alias: 'barrier_revision'
            },
            origin: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.SipMessage'
            },
            completionScope: {
                kind: 'string',
                alias: 'completion_scope'
            },
            flow: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.FlowRef'
            }
        },
        oneofs: []
    },
    '.zyno.sipbridge.v1.AuthorityReceipt': {
        fields: {
            context: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ContextRef'
            },
            application: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ProcessRef'
            },
            fromDirectoryEpoch: {
                kind: 'string',
                alias: 'from_directory_epoch'
            },
            directoryEpoch: {
                kind: 'string',
                alias: 'directory_epoch'
            },
            token: {
                kind: 'string'
            },
            barrierRevision: {
                kind: 'uint64',
                alias: 'barrier_revision'
            },
            completionScope: {
                kind: 'string',
                alias: 'completion_scope'
            },
            delivery: {
                kind: 'message',
                message: '.zyno.sipbridge.v1.ContextDelivery'
            },
            ownerLost: {
                kind: 'boolean',
                alias: 'owner_lost'
            }
        },
        oneofs: []
    }
};
