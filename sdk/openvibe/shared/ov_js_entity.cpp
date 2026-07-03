#include "cbase.h"
// OPENVIBE_WINDOWS_SERVER_QUICKJS_STUB
#if defined(_WIN32) && defined(GAME_DLL) && !defined(OPENVIBE_WINDOWS_SERVER_REAL_QUICKJS)
#include "ov_js_entity.h"

#include "tier0/memdbgon.h"

JSValue OVJS_entCreate(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv) { return JS_NULL; }
JSValue OVJS_entCall(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv) { return JS_UNDEFINED; }
#else
#include "ov_js_entity.h"
#include "util.h"
#include "baseanimating.h"
#include "eventqueue.h"
#include "gamestringpool.h"
#include "vphysics_interface.h"

#include "tier0/memdbgon.h"

// ---------------------------------------------------------------------------
// Entity natives — the C++ half of js/core/entity.js. The JS Entity wrapper
// drives real engine entities through OV.entCreate/OV.entCall; anything the
// dispatcher doesn't know returns undefined and the JS side degrades to its
// pure-JS logical entity behavior.
// ---------------------------------------------------------------------------

// Engine classes JS is allowed to create. Scripted entity classes ("ov_*")
// are also accepted; unknown ov_ classnames fail in CreateEntityByName and
// entCreate returns null, which the JS side treats as "logical entity only".
static const char *s_OVAllowedEntityClasses[] =
{
    "prop_physics",
    "prop_physics_override",
    "prop_dynamic",
    "prop_dynamic_override",
    "info_target",
    "env_sprite",
    "light_dynamic",
};

static bool OVJS_IsAllowedEntityClass(const char *className)
{
    if (!className || !className[0])
        return false;

    if (!Q_strnicmp(className, "ov_", 3))
        return true;

    for (int i = 0; i < ARRAYSIZE(s_OVAllowedEntityClasses); ++i)
    {
        if (!Q_stricmp(className, s_OVAllowedEntityClasses[i]))
            return true;
    }

    return false;
}

// Model paths JS may set: mod-relative "models/*.mdl", no traversal.
static bool OVJS_IsAllowedModelPath(const char *path)
{
    if (!path || Q_strnicmp(path, "models/", 7))
        return false;

    int len = Q_strlen(path);
    if (len < 12 || Q_stricmp(path + len - 4, ".mdl"))
        return false;

    if (Q_strstr(path, ".."))
        return false;

    return true;
}

// ---- guarded reads from the JS args array ----
static double OVJS_ArgNumber(JSContext *ctx, JSValueConst args, uint32 index, double defaultValue)
{
    if (!JS_IsObject(args))
        return defaultValue;

    JSValue v = JS_GetPropertyUint32(ctx, args, index);
    double out = defaultValue;

    if (!JS_IsUndefined(v) && !JS_IsException(v))
    {
        double d = 0.0;
        if (JS_ToFloat64(ctx, &d, v) == 0)
            out = d;
    }

    JS_FreeValue(ctx, v);
    return out;
}

static int OVJS_ArgInt(JSContext *ctx, JSValueConst args, uint32 index, int defaultValue)
{
    return (int)OVJS_ArgNumber(ctx, args, index, (double)defaultValue);
}

static bool OVJS_ArgBool(JSContext *ctx, JSValueConst args, uint32 index, bool defaultValue)
{
    if (!JS_IsObject(args))
        return defaultValue;

    JSValue v = JS_GetPropertyUint32(ctx, args, index);
    bool out = defaultValue;

    if (!JS_IsUndefined(v) && !JS_IsException(v))
        out = JS_ToBool(ctx, v) != 0;

    JS_FreeValue(ctx, v);
    return out;
}

static bool OVJS_ArgString(JSContext *ctx, JSValueConst args, uint32 index, char *out, int outSize)
{
    out[0] = '\0';

    if (!JS_IsObject(args))
        return false;

    JSValue v = JS_GetPropertyUint32(ctx, args, index);
    if (!JS_IsUndefined(v) && !JS_IsException(v))
    {
        const char *s = JS_ToCString(ctx, v);
        if (s)
        {
            Q_strncpy(out, s, outSize);
            JS_FreeCString(ctx, s);
        }
    }

    JS_FreeValue(ctx, v);
    return out[0] != '\0';
}

static JSValue OVJS_NewVectorObject(JSContext *ctx, const Vector &vec)
{
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "x", JS_NewFloat64(ctx, vec.x));
    JS_SetPropertyStr(ctx, obj, "y", JS_NewFloat64(ctx, vec.y));
    JS_SetPropertyStr(ctx, obj, "z", JS_NewFloat64(ctx, vec.z));
    return obj;
}

static JSValue OVJS_NewAngleObject(JSContext *ctx, const QAngle &ang)
{
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "p", JS_NewFloat64(ctx, ang.x));
    JS_SetPropertyStr(ctx, obj, "y", JS_NewFloat64(ctx, ang.y));
    JS_SetPropertyStr(ctx, obj, "r", JS_NewFloat64(ctx, ang.z));
    return obj;
}

static int OVJS_ClampColorComponent(int value)
{
    if (value < 0) return 0;
    if (value > 255) return 255;
    return value;
}

// OV.entCreate(className) -> {entIndex} | null
JSValue OVJS_entCreate(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv)
{
    if (argc < 1)
        return JS_NULL;

    const char *className = JS_ToCString(ctx, argv[0]);
    if (!className)
        return JS_NULL;

    if (!OVJS_IsAllowedEntityClass(className))
    {
        Warning("[OV JS] OV.entCreate refused class: %s\n", className);
        JS_FreeCString(ctx, className);
        return JS_NULL;
    }

    CBaseEntity *ent = CreateEntityByName(className);
    JS_FreeCString(ctx, className);

    if (!ent)
        return JS_NULL;

    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "entIndex", JS_NewInt32(ctx, ent->entindex()));
    return obj;
}

// The method dispatcher behind OV.entCall. Unknown methods return undefined so
// the JS wrapper can degrade gracefully.
static JSValue OVJS_EntDispatch(JSContext *ctx, CBaseEntity *ent, const char *method, JSValueConst args)
{
    // ---- lifecycle ----
    if (!Q_strcmp(method, "spawn"))
    {
        DispatchSpawn(ent);
        return JS_UNDEFINED;
    }

    if (!Q_strcmp(method, "activate"))
    {
        ent->Activate();
        return JS_UNDEFINED;
    }

    if (!Q_strcmp(method, "remove"))
    {
        UTIL_Remove(ent);
        return JS_UNDEFINED;
    }

    // ---- appearance ----
    if (!Q_strcmp(method, "setModel"))
    {
        char model[256];
        if (!OVJS_ArgString(ctx, args, 0, model, sizeof(model)))
            return JS_UNDEFINED;

        if (!OVJS_IsAllowedModelPath(model))
        {
            Warning("[OV JS] entCall setModel refused model: %s\n", model);
            return JS_UNDEFINED;
        }

        CBaseEntity::PrecacheModel(model);
        ent->SetModel(model);
        return JS_UNDEFINED;
    }

    if (!Q_strcmp(method, "setModelScale"))
    {
        CBaseAnimating *anim = ent->GetBaseAnimating();
        if (anim)
            anim->SetModelScale((float)OVJS_ArgNumber(ctx, args, 0, 1.0));
        return JS_UNDEFINED;
    }

    if (!Q_strcmp(method, "setColor"))
    {
        int r = OVJS_ClampColorComponent(OVJS_ArgInt(ctx, args, 0, 255));
        int g = OVJS_ClampColorComponent(OVJS_ArgInt(ctx, args, 1, 255));
        int b = OVJS_ClampColorComponent(OVJS_ArgInt(ctx, args, 2, 255));
        int a = OVJS_ClampColorComponent(OVJS_ArgInt(ctx, args, 3, 255));
        ent->SetRenderColor(r, g, b, a);
        return JS_UNDEFINED;
    }

    if (!Q_strcmp(method, "setMaterial"))
    {
        char material[256];
        if (OVJS_ArgString(ctx, args, 0, material, sizeof(material)))
            ent->KeyValue("material", material);
        return JS_UNDEFINED;
    }

    if (!Q_strcmp(method, "setRenderMode"))
    {
        ent->SetRenderMode((RenderMode_t)OVJS_ArgInt(ctx, args, 0, kRenderNormal));
        return JS_UNDEFINED;
    }

    if (!Q_strcmp(method, "setNoDraw"))
    {
        if (OVJS_ArgBool(ctx, args, 0, true))
            ent->AddEffects(EF_NODRAW);
        else
            ent->RemoveEffects(EF_NODRAW);
        return JS_UNDEFINED;
    }

    // ---- transform ----
    if (!Q_strcmp(method, "getPos"))
        return OVJS_NewVectorObject(ctx, ent->GetAbsOrigin());

    if (!Q_strcmp(method, "setPos"))
    {
        Vector pos(
            (float)OVJS_ArgNumber(ctx, args, 0, 0.0),
            (float)OVJS_ArgNumber(ctx, args, 1, 0.0),
            (float)OVJS_ArgNumber(ctx, args, 2, 0.0));
        ent->Teleport(&pos, NULL, NULL);
        return JS_UNDEFINED;
    }

    if (!Q_strcmp(method, "getAngles"))
        return OVJS_NewAngleObject(ctx, ent->GetAbsAngles());

    if (!Q_strcmp(method, "setAngles"))
    {
        QAngle ang(
            (float)OVJS_ArgNumber(ctx, args, 0, 0.0),
            (float)OVJS_ArgNumber(ctx, args, 1, 0.0),
            (float)OVJS_ArgNumber(ctx, args, 2, 0.0));
        ent->Teleport(NULL, &ang, NULL);
        return JS_UNDEFINED;
    }

    if (!Q_strcmp(method, "getVelocity"))
        return OVJS_NewVectorObject(ctx, ent->GetAbsVelocity());

    if (!Q_strcmp(method, "setVelocity"))
    {
        Vector vel(
            (float)OVJS_ArgNumber(ctx, args, 0, 0.0),
            (float)OVJS_ArgNumber(ctx, args, 1, 0.0),
            (float)OVJS_ArgNumber(ctx, args, 2, 0.0));

        IPhysicsObject *phys = ent->VPhysicsGetObject();
        if (phys)
            phys->SetVelocity(&vel, NULL);
        else
            ent->SetAbsVelocity(vel);
        return JS_UNDEFINED;
    }

    // ---- health / damage ----
    if (!Q_strcmp(method, "health"))
        return JS_NewInt32(ctx, ent->GetHealth());

    if (!Q_strcmp(method, "setHealth"))
    {
        ent->SetHealth(OVJS_ArgInt(ctx, args, 0, 0));
        return JS_UNDEFINED;
    }

    if (!Q_strcmp(method, "setMaxHealth"))
    {
        ent->SetMaxHealth(OVJS_ArgInt(ctx, args, 0, 0));
        return JS_UNDEFINED;
    }

    if (!Q_strcmp(method, "takeDamage"))
    {
        float damage = (float)OVJS_ArgNumber(ctx, args, 0, 0.0);
        if (damage < 0.0f)
            return JS_UNDEFINED;

        int attackerIndex = OVJS_ArgInt(ctx, args, 1, 0);
        CBaseEntity *attacker = attackerIndex > 0 ? UTIL_EntityByIndex(attackerIndex) : NULL;
        if (!attacker)
            attacker = ent;

        CTakeDamageInfo info(attacker, attacker, damage, DMG_GENERIC);
        ent->TakeDamage(info);
        return JS_UNDEFINED;
    }

    // ---- movement / collision ----
    if (!Q_strcmp(method, "setMoveType"))
    {
        ent->SetMoveType((MoveType_t)OVJS_ArgInt(ctx, args, 0, MOVETYPE_NONE));
        return JS_UNDEFINED;
    }

    if (!Q_strcmp(method, "setSolid"))
    {
        ent->SetSolid((SolidType_t)OVJS_ArgInt(ctx, args, 0, SOLID_NONE));
        return JS_UNDEFINED;
    }

    if (!Q_strcmp(method, "setCollisionGroup"))
    {
        ent->SetCollisionGroup(OVJS_ArgInt(ctx, args, 0, COLLISION_GROUP_NONE));
        return JS_UNDEFINED;
    }

    // ---- keyvalues / IO ----
    if (!Q_strcmp(method, "setKeyValue"))
    {
        char key[128], value[512];
        if (OVJS_ArgString(ctx, args, 0, key, sizeof(key)))
        {
            OVJS_ArgString(ctx, args, 1, value, sizeof(value));
            ent->KeyValue(key, value);
        }
        return JS_UNDEFINED;
    }

    if (!Q_strcmp(method, "fire"))
    {
        char input[128], param[256];
        if (!OVJS_ArgString(ctx, args, 0, input, sizeof(input)))
            return JS_UNDEFINED;

        OVJS_ArgString(ctx, args, 1, param, sizeof(param));
        float delay = (float)OVJS_ArgNumber(ctx, args, 2, 0.0);

        variant_t value;
        if (param[0])
            value.SetString(AllocPooledString(param));

        g_EventQueue.AddEvent(ent, input, value, delay, NULL, NULL);
        return JS_UNDEFINED;
    }

    // ---- physics ----
    if (!Q_strcmp(method, "physicsInit"))
    {
        int solidType = OVJS_ArgInt(ctx, args, 0, SOLID_VPHYSICS);
        if (solidType == SOLID_VPHYSICS)
            return ent->VPhysicsInitNormal(SOLID_VPHYSICS, 0, false) ? JS_TRUE : JS_FALSE;

        ent->SetSolid((SolidType_t)solidType);
        return JS_TRUE;
    }

    if (!Q_strcmp(method, "physWake"))
    {
        IPhysicsObject *phys = ent->VPhysicsGetObject();
        if (phys)
            phys->Wake();
        return JS_UNDEFINED;
    }

    if (!Q_strcmp(method, "hasPhysics"))
        return ent->VPhysicsGetObject() ? JS_TRUE : JS_FALSE;

    if (!Q_strcmp(method, "setMass"))
    {
        IPhysicsObject *phys = ent->VPhysicsGetObject();
        float mass = (float)OVJS_ArgNumber(ctx, args, 0, 1.0);
        if (phys && mass > 0.0f)
            phys->SetMass(mass);
        return JS_UNDEFINED;
    }

    if (!Q_strcmp(method, "enableMotion"))
    {
        IPhysicsObject *phys = ent->VPhysicsGetObject();
        if (phys)
            phys->EnableMotion(OVJS_ArgBool(ctx, args, 0, true));
        return JS_UNDEFINED;
    }

    if (!Q_strcmp(method, "applyForceCenter"))
    {
        IPhysicsObject *phys = ent->VPhysicsGetObject();
        if (phys)
        {
            Vector force(
                (float)OVJS_ArgNumber(ctx, args, 0, 0.0),
                (float)OVJS_ArgNumber(ctx, args, 1, 0.0),
                (float)OVJS_ArgNumber(ctx, args, 2, 0.0));
            phys->ApplyForceCenter(force);
        }
        return JS_UNDEFINED;
    }

    // ---- hierarchy ----
    if (!Q_strcmp(method, "setParent"))
    {
        int parentIndex = OVJS_ArgInt(ctx, args, 0, 0);
        CBaseEntity *parent = parentIndex > 0 ? UTIL_EntityByIndex(parentIndex) : NULL;
        ent->SetParent(parent);
        return JS_UNDEFINED;
    }

    if (!Q_strcmp(method, "setOwner"))
    {
        int ownerIndex = OVJS_ArgInt(ctx, args, 0, 0);
        CBaseEntity *owner = ownerIndex > 0 ? UTIL_EntityByIndex(ownerIndex) : NULL;
        ent->SetOwnerEntity(owner);
        return JS_UNDEFINED;
    }

    // ---- sound ----
    if (!Q_strcmp(method, "emitSound"))
    {
        char sound[256];
        if (OVJS_ArgString(ctx, args, 0, sound, sizeof(sound)))
        {
            CBaseEntity::PrecacheScriptSound(sound);
            ent->EmitSound(sound);
        }
        return JS_UNDEFINED;
    }

    // Unknown method: undefined, JS side treats it gracefully.
    return JS_UNDEFINED;
}

// OV.entCall(entIndex, method, argsArray) -> method-dependent | undefined
JSValue OVJS_entCall(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv)
{
    if (argc < 2)
        return JS_UNDEFINED;

    int32 entIndex = 0;
    JS_ToInt32(ctx, &entIndex, argv[0]);

    // World (0) and out-of-range indices are not scriptable through this path.
    CBaseEntity *ent = (entIndex > 0 && entIndex < NUM_ENT_ENTRIES) ? UTIL_EntityByIndex(entIndex) : NULL;
    if (!ent || ent->IsMarkedForDeletion())
        return JS_UNDEFINED;

    const char *method = JS_ToCString(ctx, argv[1]);
    if (!method)
        return JS_UNDEFINED;

    JSValueConst args = (argc >= 3) ? argv[2] : JS_UNDEFINED;

    JSValue result = OVJS_EntDispatch(ctx, ent, method, args);

    JS_FreeCString(ctx, method);
    return result;
}
#endif
