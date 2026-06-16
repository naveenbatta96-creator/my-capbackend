using lockbox.templatebuilder as db from '../db/schema';

service TemplateService @(requires: [
    'admin',
    'user'
]) {

    @cds.redirection.target
    @restrict: [
        {
            grant: [
                'READ',
                'CREATE',
                'UPDATE',
                'DELETE'
            ],
            to   : 'admin'
        },
        {
            grant: ['READ'],
            to   : 'user'
        }
    ]
    entity TemplateMaster          as projection on db.TemplateMaster;

    @restrict: [
        {
            grant: [
                'READ',
                'CREATE',
                'UPDATE',
                'DELETE'
            ],
            to   : 'admin'
        },
        {
            grant: ['READ'],
            to   : 'user'
        }
    ]
    entity FieldMaster             as projection on db.FieldMaster;

    @restrict: [
        {
            grant: [
                'READ',
                'UPDATE',
                'CREATE',
                'DELETE'
            ],
            to   : 'admin'
        },
        {
            grant: ['READ'],
            to   : 'user'
        }
    ]
    entity TemplateFieldMapping    as
        projection on db.TemplateFieldMapping {
            *
        };

    @readonly
    @restrict: [{
        grant: ['READ'],
        to   : [
            'admin',
            'user'
        ]
    }]
    entity templateMasterWithCount as projection on db.TemplateMasterWithCount;

    @requires: [
        'admin',
        'user'
    ]
    action addFieldsToTemplate(templateId: UUID,
                               fieldIds: many UUID);

    @requires: [
        'admin',
        'user'
    ]
    action downloadTemplate(templateID: UUID,
                            exportMode: String)    returns LargeBinary;

    @requires: [
        'admin',
        'user'
    ]
    action autoMapStandard(targetTemplateId: UUID) returns Boolean;

    @requires: 'admin'
    action setAsStandard(templateId: UUID)         returns Boolean;

    @requires: [
        'admin',
        'user'
    ]
    action autoMapAI(templateId: UUID)             returns Boolean;

}
