"""Avatars after they exist: the rows, and the owner's edits to the draft,
each a module the avatar routes (app.api.avatars) call:

    repo         rows: by id in the org, the list, by share token, a new row
                 with its source file, the creation preparing one, deletion
    sources      a new avatar for an upload, or a GLB imported by URL
    lifecycle    the rig job's preconditions, publish, discard, share
    history      snapshots before each edit, and undo
    derived      the thumbnail and layers, rebuilt after the picture moves
    photo        the background cut or restored, the crop and its reset
    fitting      the fit base, where the handles open, a fit and its save
    settings     the owner's settings, the scene picture
    mouth_edits  the teeth photo put in or taken out, the mouth kit started

Every edit here changes the DRAFT; visitors see it only after Publish
(services.publishing).
"""
