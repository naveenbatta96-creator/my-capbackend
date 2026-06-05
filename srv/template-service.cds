using lockbox.templatebuilder as db from '../db/schema';

service TemplateService {

    @cds.redirection.target
    entity TemplateMaster
        as projection on db.TemplateMaster;

    entity FieldMaster
        as projection on db.FieldMaster;

    entity TemplateFieldMapping
        as projection on db.TemplateFieldMapping;
    
    @readonly
    entity templateMasterWithCount
        as projection on db.TemplateMasterWithCount;

    action addFieldsToTemplate(
        templateId : UUID,
        fieldIds   : many UUID
    );
    action downloadTemplate(
        templateID :UUID,
        exportMode : String
    ) returns LargeBinary;

}
