/**
 * 对外视图的字段裁剪。
 *
 * 数据库的行不能直接回给客户端——里面混着内部字段（slug、qr_path、
 * schema 细节），暴露它们既是信息泄露，也让接口契约随 schema 漂移。
 *
 * 所以每个出口都显式列出字段。多写几行，换来「改 schema 不会意外泄露字段」。
 */

/**
 * 宾客能看到的活动信息。
 * 不含：slug（目录名）、qr_path（存储路径）、createdBy、状态机的内部取值。
 */
export function guestViewOfEvent(event) {
  if (!event) return null;
  return {
    id: event.id,
    title: event.title,
    coupleNames: event.coupleNames,
    eventDate: event.eventDate,
    venue: event.venue,
    welcomeText: event.welcomeText,
    uploadEnabled: event.uploadEnabled,
    status: event.status,
  };
}

/** 管理端能看到完整一些，但仍然不含 slug 之外的东西——qr_path 由专门的接口发下载 URL。 */
export function adminViewOfEvent(event) {
  if (!event) return null;
  return {
    id: event.id,
    title: event.title,
    coupleNames: event.coupleNames,
    eventDate: event.eventDate,
    venue: event.venue,
    welcomeText: event.welcomeText,
    slug: event.slug,
    uploadEnabled: event.uploadEnabled,
    status: event.status,
    qrEnvVersion: event.qrEnvVersion,
    qrMode: event.qrMode,
    qrGeneratedAt: event.qrGeneratedAt,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
    ...(event.uploadCount !== undefined
      ? {
          uploadCount: event.uploadCount,
          guestCount: event.guestCount,
          totalBytes: event.totalBytes,
        }
      : {}),
  };
}

/** 宾客的「我在这场活动的状态」 */
export function guestViewOfMembership(membership) {
  if (!membership) return null;
  return {
    displayName: membership.displayName,
    uploadCount: membership.uploadCount,
    bytesUploaded: membership.bytesUploaded,
  };
}
